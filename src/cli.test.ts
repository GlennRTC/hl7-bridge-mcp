import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { run } from './cli.js';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

// La salida del CLI es JSON libre; los tests la leen como objeto anidado.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exec = async (argv: string[], stdin?: () => string): Promise<{ exitCode: number; out: any }> => run(argv, stdin);

test('parse devuelve el AST', async () => {
  const { exitCode, out } = await exec(['parse', fixturePath('adt_a01.hl7')]);
  expect(exitCode).toBe(0);
  expect(out.ast.segments[0].name).toBe('MSH');
});

test('map ORU produce Bundle y validación explicada', async () => {
  const { exitCode, out } = await exec(['map', fixturePath('oru_r01.hl7')]);
  expect(exitCode).toBe(0);
  expect(out.bundle.entry).toHaveLength(3);
  expect(out.validation.explained).toHaveLength(out.validation.issues.length);
});

test('validate --kind fhir acepta un Bundle', async () => {
  const { exitCode, out } = await exec(['validate', fixturePath('oru_r01.bundle.json'), '--kind', 'fhir']);
  expect(exitCode).toBe(0);
  expect(Array.isArray(out.issues)).toBe(true);
});

test('stdin con "-"', async () => {
  const adt = readFileSync(fixturePath('adt_a01.hl7'), 'utf8');
  const { exitCode, out } = await exec(['validate', '-', '--kind', 'hl7v2'], () => adt);
  expect(exitCode).toBe(0);
  expect(out.issues).toEqual([]);
});

test('usage: argumentos inválidos → exit 2', async () => {
  for (const argv of [[], ['frobnicate'], ['validate', fixturePath('adt_a01.hl7')], ['map', fixturePath('oru_r01.hl7'), '--profile', 'xx']]) {
    const { exitCode, out } = await exec(argv);
    expect(exitCode, argv.join(' ')).toBe(2);
    expect(out.error.code).toBe('USAGE');
  }
});

test('errores tipados → exit 1', async () => {
  const missing = await exec(['parse', fixturePath('no_existe.hl7')]);
  expect(missing.exitCode).toBe(1);
  expect(missing.out.error.code).toBe('INPUT_READ');

  const badIssue = await exec(['explain'], () => '{"foo":1}');
  expect(badIssue.exitCode).toBe(1);
  expect(badIssue.out.error.code).toBe('INVALID_ISSUE');
});

// --- Validación remota (fetch simulado: ningún test toca la red) ---

const remoteResponse = (issues: unknown[]) =>
  new Response(JSON.stringify({ outcomes: [{ issues }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('por defecto inbuilt y sin red', async () => {
  const fetchFn = stubFetch(() => Promise.resolve(remoteResponse([])));
  const { out } = await exec(['map', fixturePath('oru_r01.hl7')]);
  expect(out.validation.validator).toEqual({ kind: 'inbuilt' });
  expect(fetchFn).not.toHaveBeenCalled();
});

test('map --validator remote reemplaza la validación inbuilt', async () => {
  const ctx = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|9.0.0';
  stubFetch(() =>
    Promise.resolve(remoteResponse([{ level: 'ERROR', location: 'Patient', message: 'm', messageId: 'X', validationContext: ctx }])),
  );
  const { exitCode, out } = await exec(['map', fixturePath('oru_r01.hl7'), '--validator', 'remote']);
  expect(exitCode).toBe(0);
  expect(out.validation.validator).toEqual({ kind: 'remote', url: 'https://validator.fhir.org', ig: 'hl7.fhir.us.core', profiles: [ctx] });
  const codes = out.validation.issues.map((i: { code: string; location: string }) => `${i.code}@${i.location}`);
  expect(codes).toContain('X@Patient');
  expect(codes.some((c: string) => c.startsWith('PROFILE_REQUIRED') || c.startsWith('CODING_NO_SYSTEM'))).toBe(false);
  expect(out.validation.explained).toHaveLength(out.validation.issues.length);
});

test('validate --kind fhir con --validator-url propio', async () => {
  const fetchFn = stubFetch(() => Promise.resolve(remoteResponse([])));
  const { exitCode, out } = await exec([
    'validate',
    fixturePath('oru_r01.bundle.json'),
    '--kind',
    'fhir',
    '--validator',
    'remote',
    '--validator-url',
    'https://v.example/',
  ]);
  expect(exitCode).toBe(0);
  expect(fetchFn.mock.calls[0]![0]).toBe('https://v.example/validate');
  expect(out.validator.url).toBe('https://v.example');
});

test('plain http only to loopback', async () => {
  for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    const fetchFn = stubFetch(() => Promise.resolve(remoteResponse([])));
    const { exitCode } = await exec(['validate', fixturePath('oru_r01.bundle.json'), '--kind', 'fhir', '--validator', 'remote', '--validator-url', url]);
    expect(exitCode, url).toBe(0);
    expect(fetchFn.mock.calls[0]![0]).toBe(`${url}/validate`);
  }
});

test('credentials in --validator-url are not echoed', async () => {
  const { exitCode, out } = await exec(['map', fixturePath('oru_r01.hl7'), '--validator', 'remote', '--validator-url', 'https://user:secret@v.example']);
  expect(exitCode).toBe(2);
  expect(JSON.stringify(out)).not.toContain('secret');
});

test('usage: opciones de validador inválidas → exit 2', async () => {
  const oru = fixturePath('oru_r01.hl7');
  for (const argv of [
    ['map', oru, '--validator', 'foo'],
    ['map', oru, '--validator-url', 'https://x'],
    ['map', oru, '--validator', 'remote', '--validator-url', 'ftp://x'],
    ['map', oru, '--validator', 'remote', '--validator-url', 'nope'],
    ['map', oru, '--validator', 'remote', '--validator-url', 'http://v.example'],
    ['map', oru, '--validator', 'remote', '--validator-url', 'http://127.evil.example'],
    ['map', oru, '--validator', 'remote', '--validator-url', 'https://user:secret@v.example'],
    ['validate', fixturePath('adt_a01.hl7'), '--kind', 'hl7v2', '--validator', 'remote'],
  ]) {
    const { exitCode, out } = await exec(argv);
    expect(exitCode, argv.join(' ')).toBe(2);
    expect(out.error.code).toBe('USAGE');
  }
});

test('fallo remoto sin fallback al inbuilt', async () => {
  stubFetch(() => Promise.reject(new TypeError('fetch failed')));
  const { exitCode, out } = await exec(['map', fixturePath('oru_r01.hl7'), '--validator', 'remote']);
  expect(exitCode).toBe(1);
  expect(out.error.code).toBe('REMOTE_VALIDATOR_UNAVAILABLE');
  expect(out).not.toHaveProperty('bundle');
});

test('JSON que no es FHIR no sale a la red', async () => {
  const fetchFn = stubFetch(() => Promise.resolve(remoteResponse([])));
  const { exitCode, out } = await exec(['validate', '-', '--kind', 'fhir', '--validator', 'remote'], () => '{"foo":1}');
  expect(exitCode).toBe(1);
  expect(out.error.code).toBe('VALIDATE_INPUT');
  expect(fetchFn).not.toHaveBeenCalled();
});

test('co-core remoto se rechaza sin llamar a la red', async () => {
  const fetchFn = stubFetch(() => Promise.resolve(remoteResponse([])));
  const { exitCode, out } = await exec([
    'map',
    fixturePath('co/adt_a01_co.hl7'),
    '--map',
    'adt_a01_to_cocore',
    '--profile',
    'co-core',
    '--validator',
    'remote',
  ]);
  expect(exitCode).toBe(1);
  expect(out.error.code).toBe('REMOTE_PROFILE_UNSUPPORTED');
  expect(fetchFn).not.toHaveBeenCalled();
});

test('maps lista ids', async () => {
  const { exitCode, out } = await exec(['maps']);
  expect(exitCode).toBe(0);
  expect(out.maps.some((m: { id: string }) => m.id === 'oru_r01_to_fhir_r4')).toBe(true);
});

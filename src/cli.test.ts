import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
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

test('maps lista ids', async () => {
  const { exitCode, out } = await exec(['maps']);
  expect(exitCode).toBe(0);
  expect(out.maps.some((m: { id: string }) => m.id === 'oru_r01_to_fhir_r4')).toBe(true);
});

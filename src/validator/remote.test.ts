import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { Hl7BridgeError } from '../errors/index.js';
import { DEFAULT_VALIDATOR_URL, validateFhirRemote } from './remote.js';

const fixture = (name: string): fhir4.Bundle =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as fhir4.Bundle;

const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition/';
const CL_PATIENT = 'https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl';

const respond = (status: number, body: unknown, contentType = 'application/json'): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });

const outcome = (issues: unknown[]) => ({ outcomes: [{ fileInfo: { fileName: 'bundle.json' }, issues }] });

/** Stub de fetch que responde siempre lo mismo y deja inspeccionar las llamadas. */
function stubFetch(response: Response | (() => Promise<Response>)) {
  const fn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    typeof response === 'function' ? response() : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof stubFetch>) => JSON.parse(fn.mock.calls[0]![1].body as string);
const sentContent = (fn: ReturnType<typeof stubFetch>) => JSON.parse(sentBody(fn).filesToValidate[0].fileContent);

async function rejection(p: Promise<unknown>): Promise<Hl7BridgeError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(Hl7BridgeError);
  const err = e as Hl7BridgeError;
  // Nunca se filtra el payload clínico en un error.
  expect(err.humanMessage).not.toContain('"resourceType"');
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('petición: IG sin versión, sv 4.0.1, locale es', async () => {
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', 'https://validator.example.org/');
  expect(fetchFn).toHaveBeenCalledOnce();
  const [url, init] = fetchFn.mock.calls[0]!;
  expect(url).toBe('https://validator.example.org/validate');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  const body = sentBody(fetchFn);
  expect(body.cliContext).toEqual({ sv: '4.0.1', igs: ['hl7.fhir.us.core'], locale: 'es' });
  expect(body.filesToValidate[0]).toMatchObject({ fileName: 'bundle.json', fileType: 'json' });
});

test('us-core: inyecta perfiles en una copia', async () => {
  const bundle = fixture('oru_r01.bundle.json');
  bundle.entry!.push({ resource: { resourceType: 'Patient', meta: { profile: ['x'] } } }, { fullUrl: 'urn:uuid:sin-recurso' });
  const before = structuredClone(bundle);
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote(bundle, 'us-core', DEFAULT_VALIDATOR_URL);
  const profiles = (sentContent(fetchFn) as fhir4.Bundle).entry!.map((e) => e.resource?.meta?.profile);
  expect(profiles).toEqual([
    [`${US_CORE}us-core-patient`],
    [`${US_CORE}us-core-observation-lab`],
    [`${US_CORE}us-core-diagnosticreport-lab`],
    ['x'],
    undefined,
  ]);
  expect(bundle).toEqual(before);
});

test('recurso suelto', async () => {
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote({ resourceType: 'Patient' }, 'us-core', DEFAULT_VALIDATOR_URL);
  expect(sentBody(fetchFn).filesToValidate[0].fileName).toBe('resource.json');
  expect(sentContent(fetchFn).meta.profile).toEqual([`${US_CORE}us-core-patient`]);
});

test('cl-core: envía el payload sin tocar', async () => {
  const bundle = fixture('cl/oru_r01_cl.bundle.json');
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote(bundle, 'cl-core', DEFAULT_VALIDATOR_URL);
  const body = sentBody(fetchFn);
  expect(body.filesToValidate[0].fileContent).toBe(JSON.stringify(bundle));
  expect(body.cliContext.igs).toEqual(['hl7.fhir.cl.clcore']);
});

test('cl-core: declara CorePacienteCl en un Patient sin perfil', async () => {
  // Sin declaración el validador solo revisaría R4 base aunque el usuario pidió CL Core.
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote(fixture('oru_r01.bundle.json'), 'cl-core', DEFAULT_VALIDATOR_URL);
  const profiles = (sentContent(fetchFn) as fhir4.Bundle).entry!.map((e) => e.resource?.meta?.profile);
  expect(profiles).toEqual([[CL_PATIENT], undefined, undefined]);
});

test('no sigue redirecciones: el payload solo va a la URL elegida', async () => {
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote({ resourceType: 'Patient' }, 'us-core', DEFAULT_VALIDATOR_URL);
  expect(fetchFn.mock.calls[0]![1].redirect).toBe('error');
});

test('prefijo de ruta del validador propio', async () => {
  const fetchFn = stubFetch(respond(200, outcome([])));
  await validateFhirRemote({ resourceType: 'Patient' }, 'us-core', 'https://host/validator/');
  expect(fetchFn.mock.calls[0]![0]).toBe('https://host/validator/validate');
});

test('traduce issues al formato del engine', async () => {
  stubFetch(
    respond(
      200,
      outcome([
        { level: 'FATAL', location: 'Bundle', message: 'm1', messageId: 'A' },
        { level: 'ERROR', location: 'Bundle.entry[0].resource/*Patient/null*/.name[0]', message: 'm2', messageId: 'B' },
        { level: 'WARNING', location: 'Patient.gender', message: 'm3' },
        { level: 'INFORMATION', location: 'Patient', message: 'm4', messageId: 'D' },
      ]),
    ),
  );
  const { issues } = await validateFhirRemote({ resourceType: 'Patient' }, 'us-core', DEFAULT_VALIDATOR_URL);
  expect(issues).toEqual([
    { severity: 'error', code: 'A', location: 'Bundle', message: 'm1' },
    { severity: 'error', code: 'B', location: 'Bundle.entry[0].resource.name[0]', message: 'm2' },
    { severity: 'warning', code: 'REMOTE_ISSUE', location: 'Patient.gender', message: 'm3' },
    { severity: 'information', code: 'D', location: 'Patient', message: 'm4' },
  ]);
});

test('procedencia: perfiles del IG con versión, sin los base', async () => {
  const ctx = `${CL_PATIENT}|1.9.4`;
  stubFetch(
    respond(
      200,
      outcome([
        { level: 'ERROR', location: 'Bundle', message: 'a', messageId: 'X', validationContext: ctx },
        { level: 'ERROR', location: 'Bundle', message: 'b', messageId: 'X', validationContext: ctx },
        { level: 'WARNING', location: 'Bundle', message: 'c', messageId: 'Y', validationContext: 'http://hl7.org/fhir/StructureDefinition/Patient|4.0.1' },
      ]),
    ),
  );
  const { validator } = await validateFhirRemote(fixture('cl/oru_r01_cl.bundle.json'), 'cl-core', DEFAULT_VALIDATOR_URL);
  expect(validator).toEqual({ kind: 'remote', url: 'https://validator.fhir.org', ig: 'hl7.fhir.cl.clcore', profiles: [ctx] });
});

test('bundle válido: sin issues ni perfiles', async () => {
  stubFetch(respond(200, outcome([])));
  const res = await validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', DEFAULT_VALIDATOR_URL);
  expect(res.issues).toEqual([]);
  expect(res.validator.profiles).toEqual([]);
});

test('co-core rechazado antes de llamar', async () => {
  const fetchFn = stubFetch(respond(200, outcome([])));
  const err = await rejection(validateFhirRemote(fixture('co/oru_r01_co.bundle.json'), 'co-core', DEFAULT_VALIDATOR_URL));
  expect(err.code).toBe('REMOTE_PROFILE_UNSUPPORTED');
  expect(err.location).toBe('--profile');
  expect(fetchFn).not.toHaveBeenCalled();
});

test('red caída o timeout → UNAVAILABLE', async () => {
  for (const cause of [new TypeError('fetch failed'), new DOMException('t', 'TimeoutError')]) {
    stubFetch(() => Promise.reject(cause));
    const err = await rejection(validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', DEFAULT_VALIDATOR_URL));
    expect(err.code).toBe('REMOTE_VALIDATOR_UNAVAILABLE');
    expect(err.location).toBe('https://validator.fhir.org');
  }
});

test('5xx → UNAVAILABLE con el cuerpo truncado a 200', async () => {
  stubFetch(respond(503, 'a'.repeat(500), 'text/plain'));
  const err = await rejection(validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', DEFAULT_VALIDATOR_URL));
  expect(err.code).toBe('REMOTE_VALIDATOR_UNAVAILABLE');
  expect(err.humanMessage).toContain('503');
  expect(err.humanMessage).toContain('a'.repeat(200));
  expect(err.humanMessage).not.toContain('a'.repeat(201));
});

test('4xx → REJECTED', async () => {
  stubFetch(respond(400, 'No files for validation provided in request.', 'text/plain'));
  const err = await rejection(validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', DEFAULT_VALIDATOR_URL));
  expect(err.code).toBe('REMOTE_VALIDATOR_REJECTED');
  expect(err.humanMessage).toContain('400');
});

test('200 sin la forma esperada → REJECTED', async () => {
  // outcomes vacío = el archivo no se validó; issues con basura = no es la respuesta del validador.
  for (const response of [
    respond(200, {}),
    respond(200, '<html>', 'text/html'),
    respond(200, { outcomes: [] }),
    respond(200, outcome([null])),
    respond(200, outcome([{ level: 'ERROR', location: 42, message: 'm' }])),
  ]) {
    stubFetch(response);
    const err = await rejection(validateFhirRemote(fixture('oru_r01.bundle.json'), 'us-core', DEFAULT_VALIDATOR_URL));
    expect(err.code).toBe('REMOTE_VALIDATOR_REJECTED');
  }
});

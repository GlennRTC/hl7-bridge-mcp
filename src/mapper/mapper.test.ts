import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Hl7BridgeError } from '../errors/index.js';
import { parseHl7v2 } from '../parser/index.js';
import { loadMaps, mapSchema, mapV2ToFhir, resolveV2Path, transforms } from './index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

/** Ids deterministas para comparar contra los bundles esperados. */
const seqIds = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};

const maps = loadMaps();

test('los mapas del repo cumplen el esquema', () => {
  expect(maps.map((m) => m.id).sort()).toEqual(['adt_a01_to_fhir_r4', 'orm_o01_to_fhir_r4', 'oru_r01_to_fhir_r4', 'oul_r22_to_fhir_r4']);
});

test.each(['adt_a01', 'oru_r01', 'orm_o01'])('%s.hl7 → bundle esperado', (name) => {
  const bundle = mapV2ToFhir(fixture(`${name}.hl7`), { maps, newId: seqIds() });
  expect(bundle).toEqual(JSON.parse(fixture(`${name}.bundle.json`)));
});

test('hl7_coding_system: LN→LOINC, código no registrado no puebla system', () => {
  const cs = transforms['hl7_coding_system']!;
  expect(cs('LN', { message: {} as never })).toBe('http://loinc.org');
  expect(cs('99LOCAL', { message: {} as never })).toBeUndefined();
});

test('selección explícita por mapId', () => {
  const bundle = mapV2ToFhir(fixture('oru_r01.hl7'), { maps, mapId: 'oru_r01_to_fhir_r4', newId: seqIds() });
  expect(bundle).toEqual(JSON.parse(fixture('oru_r01.bundle.json')));
});

test('tipo de mensaje sin mapa → MAP_NOT_FOUND', () => {
  const raw = 'MSH|^~\\&|A|B|||20260101||SIU^S12|1|P|2.5';
  expect(() => mapV2ToFhir(raw, { maps })).toThrowError(
    expect.objectContaining({ code: 'MAP_NOT_FOUND', location: 'MSH-9' }),
  );
});

test('segmento ancla repetido → un recurso por ocurrencia', () => {
  const raw = [
    'MSH|^~\\&|LAB|H|EMR|H|20260101||ORU^R01|1|P|2.5',
    'PID|1||42||PEREZ^ANA||19900215|F',
    'OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|||||F',
    'OBX|2|ST|GLU-NOTE^COMENTARIO||dentro de rango||||||F',
  ].join('\r');
  const bundle = mapV2ToFhir(raw, { maps, newId: seqIds() });
  expect(bundle.entry).toHaveLength(3);
  const [patient, obs1, obs2] = bundle.entry!.map((e) => e.resource) as [fhir4.Patient, fhir4.Observation, fhir4.Observation];
  expect(patient.resourceType).toBe('Patient');
  expect(obs1.valueQuantity).toEqual({ value: 95, unit: 'mg/dL' });
  expect(obs2.valueString).toBe('dentro de rango');
  expect(obs1.subject).toEqual(obs2.subject);
});

test('hl7_datetime: fecha, fecha-hora y offset', () => {
  const ctx = { message: parseHl7v2('MSH|^~\\&|A|B|||20260101||ADT^A01|1|P|2.5') };
  expect(transforms['hl7_datetime']!('19800101', ctx)).toBe('1980-01-01');
  expect(transforms['hl7_datetime']!('20260102074500', ctx)).toBe('2026-01-02T07:45:00');
  expect(transforms['hl7_datetime']!('202601020745-0500', ctx)).toBe('2026-01-02T07:45:00-05:00');
  expect(() => transforms['hl7_datetime']!('mañana', ctx)).toThrowError(Hl7BridgeError);
});

test('hl7_result_status: conocidos y desconocidos', () => {
  const ctx = { message: parseHl7v2('MSH|^~\\&|A|B|||20260101||ORU^R01|1|P|2.5') };
  expect(transforms['hl7_result_status']!('F', ctx)).toBe('final');
  expect(transforms['hl7_result_status']!('P', ctx)).toBe('preliminary');
  expect(transforms['hl7_result_status']!('ZZ', ctx)).toBe('unknown');
});

test('obx_value_by_obx2: CE/CWE puebla system desde OBX-5.3 (tabla 0396)', () => {
  const msg = parseHl7v2('MSH|^~\\&|A|B|||20260101||ORU^R01|1|P|2.5\rOBX|1|CE|664-3^COLOR^LN||Y^Yellow^LN||||||F');
  const obx = msg.segments[1]!;
  expect(transforms['obx_value_by_obx2']!('Y^Yellow^LN', { segment: obx, message: msg })).toEqual({
    valueCodeableConcept: { coding: [{ code: 'Y', display: 'Yellow', system: 'http://loinc.org' }] },
  });
});

test('obx_value_by_obx2: CWE con coding alternativo (CWE.4/5/6) → coding[1]', () => {
  const msg = parseHl7v2('MSH|^~\\&|A|B|||20260101||ORU^R01|1|P|2.5\rOBX|1|CWE|664-3^COLOR^LN||Y^Yellow^LN^371244009^Yellow color^SCT||||||F');
  const obx = msg.segments[1]!;
  expect(transforms['obx_value_by_obx2']!('Y^Yellow^LN^371244009^Yellow color^SCT', { segment: obx, message: msg })).toEqual({
    valueCodeableConcept: {
      coding: [
        { code: 'Y', display: 'Yellow', system: 'http://loinc.org' },
        { code: '371244009', display: 'Yellow color', system: 'http://snomed.info/sct' },
      ],
    },
  });
});

test('hl7_order_status: 0119 conocido, unmatched y desconocido', () => {
  const os = transforms['hl7_order_status']!;
  expect(os('NW', { message: {} as never })).toBe('active');
  expect(os('DC', { message: {} as never })).toBe('revoked');
  expect(os('ZZ', { message: {} as never })).toBe('unknown');
});

test('hl7_patient_class: E/I/O/P→ActCode, R/B/C/N/U→v2-0004, fuera de tabla→undefined', () => {
  const pc = transforms['hl7_patient_class']!;
  expect(pc('I', { message: {} as never })).toEqual({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP' });
  expect(pc('R', { message: {} as never })).toEqual({ system: 'http://terminology.hl7.org/CodeSystem/v2-0004', code: 'R' });
  expect(pc('ZZ', { message: {} as never })).toBeUndefined();
});

test('hl7_report_status: 0123 conocido y unmatched', () => {
  const rs = transforms['hl7_report_status']!;
  expect(rs('F', { message: {} as never })).toBe('final');
  expect(rs('R', { message: {} as never })).toBe('partial');
  expect(rs('A', { message: {} as never })).toBe('unknown');
});

test('refAll con más de un OBR → MAP_INVALID (agrupación OBR→OBX no soportada)', () => {
  const raw = [
    'MSH|^~\\&|LAB|H|EMR|H|20260101||ORU^R01|1|P|2.5',
    'PID|1||42||PEREZ^ANA||19900215|F',
    'OBR|1|A||1554-5^GLUCOSE^LN|||20260101||||||||||||||||||F',
    'OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|||||F',
    'OBR|2|B||2345-7^GLUCOSE2^LN|||20260101||||||||||||||||||F',
    'OBX|2|NM|2345-7^GLUCOSE2^LN||99|mg/dL|||||F',
  ].join('\r');
  expect(() => mapV2ToFhir(raw, { maps })).toThrowError(
    expect.objectContaining({ code: 'MAP_INVALID' }),
  );
});

test('OUL^R22 con más de un SPM → MAP_INVALID (ref: Specimen ambiguo, agrupación SPM→OBX no soportada)', () => {
  const raw = [
    'MSH|^~\\&|LIS|H|EMR|H|20260101||OUL^R22|1|P|2.5',
    'PID|1||42||PEREZ^ANA||19900215|F',
    'SPM|1|S1||119364003^Serum^SCT',
    'OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|||||F',
    'SPM|2|S2||122575003^Urine^SCT',
    'OBX|2|NM|2345-7^PROTEIN^LN||30|mg/dL|||||F',
  ].join('\r');
  // Sin el guardián, cada OBX se ataría silenciosamente al primer Specimen (resultado en el espécimen equivocado).
  expect(() => mapV2ToFhir(raw, { maps })).toThrowError(
    expect.objectContaining({ code: 'MAP_INVALID' }),
  );
});

test('obx_value_by_obx2: tipo no soportado → MAP_TRANSFORM', () => {
  const msg = parseHl7v2('MSH|^~\\&|A|B|||20260101||ORU^R01|1|P|2.5\rOBX|1|XX|C^D||valor||||||F');
  const obx = msg.segments[1]!;
  expect(() => transforms['obx_value_by_obx2']!('valor', { segment: obx, message: msg })).toThrowError(
    expect.objectContaining({ code: 'MAP_TRANSFORM' }),
  );
});

test('rutas v2: ancla vs global y ruta inválida', () => {
  const msg = parseHl7v2(fixture('oru_r01.hl7'));
  expect(resolveV2Path(msg, 'PID-5.1')).toBe('DOE');
  expect(resolveV2Path(msg, 'OBX-5', msg.segments[3])).toBe('95');
  expect(resolveV2Path(msg, 'PID-99')).toBeUndefined();
  expect(() => resolveV2Path(msg, 'pid5')).toThrowError(
    expect.objectContaining({ code: 'MAP_INVALID_PATH' }),
  );
});

test('mapa que no cumple el esquema es rechazado', () => {
  expect(mapSchema.safeParse({ id: 'x', resources: 'nope' }).success).toBe(false);
});

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Hl7BridgeError } from '../errors/index.js';
import { explainError, validateFhir, validateMessage, validateV2, type Issue } from './index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

const codesAt = (issues: Issue[]) => issues.map((i) => `${i.code}@${i.location}`).sort();

test('mensajes válidos no producen issues v2', () => {
  expect(validateV2(fixture('adt_a01.hl7'))).toEqual([]);
  expect(validateV2(fixture('oru_r01.hl7'))).toEqual([]);
  expect(validateV2(fixture('orm_o01.hl7'))).toEqual([]);
});

test('ADT sin PV1 ni nombre → segmento y campo faltantes', () => {
  expect(codesAt(validateV2(fixture('invalid_adt_missing_name.hl7')))).toEqual([
    'MISSING_FIELD@PID-5',
    'MISSING_SEGMENT@PV1',
  ]);
});

test('ORU sin OBR ni código de observación → segmento y campo faltantes', () => {
  expect(codesAt(validateV2(fixture('invalid_oru_missing_obr_code.hl7')))).toEqual([
    'MISSING_FIELD@OBX-3',
    'MISSING_SEGMENT@OBR',
  ]);
});

test('tipo de mensaje sin reglas → NO_PROFILE (warning)', () => {
  const issues = validateV2('MSH|^~\\&|A|B|||20260101||SIU^S12|1|P|2.5');
  expect(issues).toEqual([{ severity: 'warning', code: 'NO_PROFILE', location: 'MSH-9', message: expect.any(String) }]);
});

test('validación FHIR: Observation sin category incumple US Core', () => {
  const bundle: fhir4.Bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    // Válido salvo por category: aísla que la única falla de perfil es esa.
    entry: [{ resource: { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '1554-5' }] }, subject: { reference: 'urn:x' }, valueString: '95' } as fhir4.Observation }],
  };
  expect(codesAt(validateFhir(bundle))).toEqual(['PROFILE_REQUIRED@Observation.category']);
});

test('validación FHIR: recurso suelto (no Bundle) se valida directo', () => {
  const patient = { resourceType: 'Patient', identifier: [{ value: '123456' }] } as fhir4.Patient;
  expect(codesAt(validateFhir(patient)).sort()).toEqual([
    'PROFILE_REQUIRED@Patient.gender',
    'PROFILE_REQUIRED@Patient.identifier',
    'PROFILE_REQUIRED@Patient.name',
  ]);
});

test('validación FHIR: Coding sin system → warning; sin code → error; con system → nada', () => {
  const obs = (coding: fhir4.Coding): fhir4.Bundle => ({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: { resourceType: 'Observation', status: 'final', subject: { reference: 'urn:x' }, category: [{ coding: [{ system: 'x', code: 'laboratory' }] }], code: { coding: [coding] } } as fhir4.Observation }],
  });
  const only = (b: fhir4.Bundle) => validateFhir(b).filter((i) => i.location === 'Observation.code.coding[0]');
  expect(only(obs({ code: '1554-5' }))).toEqual([expect.objectContaining({ severity: 'warning', code: 'CODING_NO_SYSTEM' })]);
  expect(only(obs({ display: 'x' }))).toEqual([expect.objectContaining({ severity: 'error', code: 'CODING_EMPTY' })]);
  expect(only(obs({ code: '1554-5', system: 'http://loinc.org' }))).toEqual([]);
});

test('validateMessage despacha por kind y rechaza payload incorrecto', () => {
  expect(validateMessage(fixture('adt_a01.hl7'), 'hl7v2')).toEqual([]);
  expect(() => validateMessage('no es un bundle', 'fhir')).toThrowError(
    expect.objectContaining({ code: 'VALIDATE_INPUT' }),
  );
  expect(() => validateMessage({} as never, 'hl7v2')).toThrowError(Hl7BridgeError);
});

test('explainError: campo faltante → ubicación legible y hint accionable', () => {
  const exp = explainError({ severity: 'error', code: 'MISSING_FIELD', location: 'OBR-4', message: 'Falta el campo requerido OBR-4 para ORM^O01.' });
  expect(exp.location).toContain('código de estudio');
  expect(exp.hint).toMatch(/campo requerido/);
});

test('explainError: resuelve valor de tabla HL7 (OBX-11 F = Final)', () => {
  const exp = explainError({ severity: 'information', code: 'CODED', location: 'OBX-11', message: "OBX-11 tiene el valor 'F'." });
  expect(exp.location).toContain('Estado del resultado');
  expect(exp.humanMessage).toContain('Final');
  expect(exp.humanMessage).toContain('0085');
});

test('explainError: issue FHIR sin catálogo conserva ubicación y usa hint por código', () => {
  const exp = explainError({ severity: 'error', code: 'PROFILE_REQUIRED', location: 'Observation.category', message: 'US Core Observation requiere category.' });
  expect(exp.location).toBe('Observation.category');
  expect(exp.hint).toMatch(/must-support/);
});

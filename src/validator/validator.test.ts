import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Hl7BridgeError } from '../errors/index.js';
import { loadMaps, mapV2ToFhir } from '../mapper/index.js';
import { explainError, validateFhir, validateMessage, validateV2, type Issue } from './index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

const maps = loadMaps();
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
  const bundle = mapV2ToFhir(fixture('oru_r01.hl7'), { maps });
  expect(codesAt(validateFhir(bundle))).toEqual(['PROFILE_REQUIRED@Observation.category']);
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

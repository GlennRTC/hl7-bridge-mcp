import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Hl7BridgeError } from '../errors/index.js';
import { parseHl7v2, resolveTable, type Hl7Message } from './index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

/** Valor simple de SEG-n[rep].comp.sub (índices 1-based, como en la spec). */
const val = (msg: Hl7Message, seg: string, n: number, rep = 1, comp = 1, sub = 1): string | undefined =>
  msg.segments.find((s) => s.name === seg)?.fields[n - 1]?.repetitions[rep - 1]?.components[comp - 1]?.subcomponents[sub - 1];

test('ADT^A01: estructura, repeticiones y componentes', () => {
  const msg = parseHl7v2(fixture('adt_a01.hl7'));
  expect(msg.segments.map((s) => s.name)).toEqual(['MSH', 'EVN', 'PID', 'NK1', 'PV1']);
  expect(val(msg, 'MSH', 1)).toBe('|');
  expect(val(msg, 'MSH', 2)).toBe('^~\\&');
  expect(val(msg, 'MSH', 9, 1, 1)).toBe('ADT');
  expect(val(msg, 'MSH', 9, 1, 2)).toBe('A01');
  // PID-3 con dos repeticiones (MR y SS)
  const pid3 = msg.segments[2]!.fields[2]!;
  expect(pid3.repetitions).toHaveLength(2);
  expect(val(msg, 'PID', 3, 1, 1)).toBe('123456');
  expect(val(msg, 'PID', 3, 2, 1)).toBe('999-99-9999');
  expect(val(msg, 'PID', 3, 2, 5)).toBe('SS');
  expect(val(msg, 'PID', 5, 1, 1)).toBe('DOE');
  expect(val(msg, 'PID', 5, 1, 2)).toBe('JOHN');
  expect(val(msg, 'PID', 8)).toBe('M');
  expect(val(msg, 'NK1', 3, 1, 2)).toBe('Spouse');
});

test('ORU^R01: OBX y escape \\T\\ des-escapado', () => {
  const msg = parseHl7v2(fixture('oru_r01.hl7'));
  expect(val(msg, 'OBX', 2)).toBe('NM');
  expect(val(msg, 'OBX', 5)).toBe('95');
  expect(val(msg, 'OBX', 11)).toBe('F');
  expect(val(msg, 'NTE', 3)).toBe('Muestra en ayunas S&E confirmada');
});

test('ORM^O01: ORC y OBR', () => {
  const msg = parseHl7v2(fixture('orm_o01.hl7'));
  expect(val(msg, 'ORC', 1)).toBe('NW');
  expect(val(msg, 'OBR', 4, 1, 2)).toBe('GLUCOSE');
});

test('separadores no estándar leídos de MSH-1/MSH-2', () => {
  const msg = parseHl7v2('MSH:-+?*:APP:FAC:::20260101::ADT-A01:1:P:2.5\rPID:1::42:.:PEREZ-ANA');
  expect(msg.encoding).toEqual({ field: ':', component: '-', repetition: '+', escape: '?', subcomponent: '*' });
  expect(val(msg, 'MSH', 9, 1, 2)).toBe('A01');
  expect(val(msg, 'PID', 5, 1, 1)).toBe('PEREZ');
  expect(val(msg, 'PID', 5, 1, 2)).toBe('ANA');
});

test('subcomponentes y finales de línea \\r, \\n y \\r\\n', () => {
  for (const eol of ['\r', '\n', '\r\n']) {
    const msg = parseHl7v2(`MSH|^~\\&|A|B|||20260101||ADT^A01|1|P|2.5${eol}PID|1||X&Y^Z`);
    expect(val(msg, 'PID', 3, 1, 1, 1)).toBe('X');
    expect(val(msg, 'PID', 3, 1, 1, 2)).toBe('Y');
    expect(val(msg, 'PID', 3, 1, 2)).toBe('Z');
  }
});

test('tablas: resolución opcional de códigos', () => {
  expect(resolveTable('0001', 'M')).toBe('Male');
  expect(resolveTable('0085', 'F')).toBe('Final');
  expect(resolveTable('0001', 'ZZ')).toBeUndefined();
  expect(resolveTable('9999', 'M')).toBeUndefined();
});

test.each([
  ['', 'EMPTY_MESSAGE', 'message'],
  ['PID|1||42', 'INVALID_HEADER', 'MSH'],
  ['MSH', 'INVALID_HEADER', 'MSH-1'],
  ['MSH|^~|A|B', 'INVALID_ENCODING', 'MSH-2'],
  ['MSH|^~\\&|A|B|||20260101||ADT^A01|1|P|2.5\rxx|1', 'INVALID_SEGMENT', 'línea 2'],
])('mensaje malformado %#: error %s en %s', (raw, code, location) => {
  try {
    parseHl7v2(raw);
    expect.unreachable('debió lanzar Hl7BridgeError');
  } catch (e) {
    const err = e as Hl7BridgeError;
    expect(err).toBeInstanceOf(Hl7BridgeError);
    expect(err.code).toBe(code);
    expect(err.location).toBe(location);
  }
});

test('rendimiento: ~50 segmentos en < 20 ms (RNF2)', () => {
  const obx = Array.from({ length: 60 }, (_, i) => `OBX|${i + 1}|NM|1554-5^GLUCOSE^LN||${90 + i}|mg/dL|70-105|N|||F`);
  const big = ['MSH|^~\\&|LAB|H|EMR|H|20260101||ORU^R01|1|P|2.5', 'PID|1||123456^^^H^MR||DOE^JOHN', ...obx].join('\r');
  const t0 = performance.now();
  const msg = parseHl7v2(big);
  const ms = performance.now() - t0;
  expect(msg.segments).toHaveLength(62);
  expect(ms).toBeLessThan(20);
});

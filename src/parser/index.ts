import { Hl7BridgeError } from '../errors/index.js';
import type { Encoding, Field, Hl7Message, Segment } from './types.js';

export type { Hl7Message } from './types.js';
export { resolveTable } from './tables.js';

const SEGMENT_NAME = /^[A-Z][A-Z0-9]{2}$/;

export function parseHl7v2(raw: string): Hl7Message {
  if (raw.trim() === '') {
    throw new Hl7BridgeError('EMPTY_MESSAGE', 'message', 'El mensaje está vacío.');
  }
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l !== '');

  const msh = lines[0];
  if (msh === undefined || !msh.startsWith('MSH')) {
    throw new Hl7BridgeError('INVALID_HEADER', 'MSH', 'El mensaje debe comenzar con un segmento MSH.');
  }
  const fieldSep = msh[3];
  if (fieldSep === undefined) {
    throw new Hl7BridgeError('INVALID_HEADER', 'MSH-1', 'Falta el separador de campo tras "MSH".');
  }
  const encChars = msh.split(fieldSep)[1] ?? '';
  if (encChars.length < 4) {
    throw new Hl7BridgeError(
      'INVALID_ENCODING',
      'MSH-2',
      `Los caracteres de encoding deben ser al menos 4 (ej. ^~\\&); se recibió "${encChars}".`,
    );
  }
  // ponytail: v2.7 añade un 5º carácter (truncamiento); se acepta y se ignora hasta que algo lo necesite.
  const encoding: Encoding = {
    field: fieldSep,
    component: encChars[0]!,
    repetition: encChars[1]!,
    escape: encChars[2]!,
    subcomponent: encChars[3]!,
  };

  const segments = lines.map((line, i) => parseSegment(line, encoding, i + 1));
  return { encoding, segments };
}

function parseSegment(line: string, enc: Encoding, lineNo: number): Segment {
  const name = line.slice(0, 3);
  if (!SEGMENT_NAME.test(name)) {
    throw new Hl7BridgeError(
      'INVALID_SEGMENT',
      `línea ${lineNo}`,
      `"${name}" no es un nombre de segmento HL7 válido (3 caracteres, ej. PID).`,
    );
  }
  const rawFields = line.split(enc.field);
  if (name === 'MSH') {
    // MSH-1 es el propio separador y MSH-2 los caracteres de encoding: literales, sin sub-parsear.
    return {
      name,
      fields: [literalField(enc.field), literalField(rawFields[1] ?? ''), ...rawFields.slice(2).map((f) => parseField(f, enc))],
    };
  }
  return { name, fields: rawFields.slice(1).map((f) => parseField(f, enc)) };
}

function parseField(raw: string, enc: Encoding): Field {
  return {
    repetitions: raw.split(enc.repetition).map((rep) => ({
      components: rep.split(enc.component).map((comp) => ({
        subcomponents: comp.split(enc.subcomponent).map((sub) => unescape(sub, enc)),
      })),
    })),
  };
}

function literalField(value: string): Field {
  return { repetitions: [{ components: [{ subcomponents: [value] }] }] };
}

/** Decodifica \F\ \S\ \T\ \R\ \E\. Otras secuencias (\Xdd\, \.br\...) quedan literales. */
function unescape(value: string, enc: Encoding): string {
  if (!value.includes(enc.escape)) return value;
  const esc = escapeRegExp(enc.escape);
  return value.replace(new RegExp(`${esc}(.*?)${esc}`, 'g'), (match, seq: string) => {
    switch (seq) {
      case 'F': return enc.field;
      case 'S': return enc.component;
      case 'T': return enc.subcomponent;
      case 'R': return enc.repetition;
      case 'E': return enc.escape;
      default: return match;
    }
  });
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

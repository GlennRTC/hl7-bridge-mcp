import { expect, test } from 'vitest';
import { Hl7BridgeError } from './index.js';

test('Hl7BridgeError expone code, location y humanMessage', () => {
  const err = new Hl7BridgeError('PARSE_ERROR', 'MSH-1', 'Separador de campo ausente');
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe('PARSE_ERROR');
  expect(err.location).toBe('MSH-1');
  expect(err.message).toBe('[PARSE_ERROR] MSH-1: Separador de campo ausente');
});

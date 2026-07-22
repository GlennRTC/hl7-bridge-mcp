import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { redactMessage } from './log.js';
import { createServer } from './server.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const payload = (r: CallToolResult): { text: string } => (r.content as { type: string; text: string }[])[0]!;

test('el servidor expone las 4 tools del MVP', async () => {
  const client = await connectClient();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(['explain_error', 'map_v2_to_fhir', 'parse_hl7v2', 'validate_message']);
});

test('e2e: ORU^R01 crudo → map_v2_to_fhir → Bundle validado; validador señala deuda real', async () => {
  const client = await connectClient();
  const res = (await client.callTool({ name: 'map_v2_to_fhir', arguments: { message: fixture('oru_r01.hl7') } })) as CallToolResult;
  expect(res.isError).toBeFalsy();
  const out = JSON.parse(payload(res).text) as {
    bundle: fhir4.Bundle;
    validation: { issues: { code: string; location: string }[]; explained: { humanMessage: string; hint: string }[] };
  };
  expect(out.bundle.entry!.map((e) => e.resource!.resourceType)).toEqual(['Patient', 'Observation', 'DiagnosticReport']);
  // La Observation satisface US Core (category=laboratory, code.coding, value[x], subject).
  const obs = out.bundle.entry!.find((e) => e.resource!.resourceType === 'Observation')!.resource as fhir4.Observation;
  expect(obs.category![0]!.coding![0]!.code).toBe('laboratory');
  // El Patient también satisface US Core: identifier con value (PID-3.1) y system (PID-3.4).
  expect(out.validation.issues).toEqual([]);
});

test('mensaje malformado → isError con error tipado', async () => {
  const client = await connectClient();
  const res = (await client.callTool({ name: 'parse_hl7v2', arguments: { message: 'PID|1||42' } })) as CallToolResult;
  expect(res.isError).toBe(true);
  expect(JSON.parse(payload(res).text)).toEqual({ error: { code: 'INVALID_HEADER', location: 'MSH', humanMessage: expect.any(String) } });
});

test('validate_message con Bundle FHIR (kind=fhir)', async () => {
  const client = await connectClient();
  const bundle: fhir4.Bundle = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Patient' } }] };
  const res = (await client.callTool({ name: 'validate_message', arguments: { payload: JSON.stringify(bundle), kind: 'fhir' } })) as CallToolResult;
  const out = JSON.parse(payload(res).text) as { issues: { location: string }[] };
  expect(out.issues.map((i) => i.location).sort()).toEqual(['Patient.gender', 'Patient.identifier', 'Patient.name']);
});

test('validate_message con JSON malformado → INVALID_JSON tipado, no INTERNAL', async () => {
  const client = await connectClient();
  const res = (await client.callTool({ name: 'validate_message', arguments: { payload: '{"resourceType":"Patient"},"x":1}', kind: 'fhir' } })) as CallToolResult;
  expect(res.isError).toBe(true);
  const err = (JSON.parse(payload(res).text) as { error: { code: string; location: string } }).error;
  expect(err.code).toBe('INVALID_JSON');
  expect(err.location).toBe('payload');
});

test('redactMessage oculta segmentos con PHI y preserva el resto', () => {
  const redacted = redactMessage(fixture('adt_a01.hl7'));
  expect(redacted).toContain('MSH|^~\\&|HIS');
  expect(redacted).toContain('PID|[REDACTED]');
  expect(redacted).toContain('NK1|[REDACTED]');
  expect(redacted).not.toContain('DOE');
});

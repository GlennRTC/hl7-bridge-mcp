import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Hl7BridgeError } from '../errors/index.js';
import { mapV2ToFhir } from '../mapper/index.js';
import { parseHl7v2 } from '../parser/index.js';
import { explainError, validateFhir, validateMessage } from '../validator/index.js';
import { logMessageDebug, logTool } from './log.js';

const issueSchema = z.object({
  severity: z.enum(['error', 'warning', 'information']),
  code: z.string(),
  location: z.string(),
  message: z.string(),
});

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** JSON malformado es error de entrada del usuario, no un fallo interno: error tipado y accionable. */
function parseFhirPayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (e) {
    throw new Hl7BridgeError('INVALID_JSON', 'payload', `El payload FHIR no es JSON válido: ${(e as Error).message}`);
  }
}

function fail(e: unknown): CallToolResult {
  const error =
    e instanceof Hl7BridgeError
      ? { code: e.code, location: e.location, humanMessage: e.humanMessage }
      : { code: 'INTERNAL', location: '-', humanMessage: (e as Error).message };
  return { content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'hl7-bridge-mcp', version: '0.1.0' });

  server.registerTool(
    'parse_hl7v2',
    {
      description: 'Parsea un mensaje HL7 v2 a un AST tipado (segmentos, campos, componentes) con los separadores leídos de MSH-1/MSH-2.',
      inputSchema: { message: z.string() },
    },
    ({ message }) => {
      try {
        logMessageDebug('parse_hl7v2', message);
        const ast = parseHl7v2(message);
        logTool('parse_hl7v2', 'ok');
        return ok({ ast });
      } catch (e) {
        logTool('parse_hl7v2', 'error');
        return fail(e);
      }
    },
  );

  server.registerTool(
    'map_v2_to_fhir',
    {
      description: 'Mapea un mensaje HL7 v2 a un Bundle FHIR R4 con un mapa declarativo y valida el resultado contra el perfil indicado (US Core por defecto; cl-core/co-core para packs nacionales), explicando cada issue.',
      inputSchema: { message: z.string(), mapId: z.string().optional(), fhirVersion: z.enum(['R4', 'R6']).optional(), profile: z.enum(['us-core', 'cl-core', 'co-core']).optional() },
    },
    ({ message, mapId, fhirVersion, profile }) => {
      try {
        if (fhirVersion === 'R6') {
          throw new Hl7BridgeError('UNSUPPORTED_VERSION', 'fhirVersion', 'FHIR R6 aún no soportado en v0.1; usa R4.');
        }
        logMessageDebug('map_v2_to_fhir', message);
        const bundle = mapV2ToFhir(message, { mapId });
        const issues = validateFhir(bundle, profile);
        const explained = issues.map(explainError);
        logTool('map_v2_to_fhir', `ok (${issues.length} issues)`);
        return ok({ bundle, validation: { issues, explained } });
      } catch (e) {
        logTool('map_v2_to_fhir', 'error');
        return fail(e);
      }
    },
  );

  server.registerTool(
    'validate_message',
    {
      description: 'Valida un mensaje HL7 v2 (segmentos/campos requeridos) o un Bundle FHIR contra un perfil (US Core por defecto; cl-core/co-core para packs nacionales) y devuelve issues estructurados.',
      inputSchema: { payload: z.string(), kind: z.enum(['hl7v2', 'fhir']), profile: z.enum(['us-core', 'cl-core', 'co-core']).optional() },
    },
    ({ payload, kind, profile }) => {
      try {
        const parsed = kind === 'fhir' ? (parseFhirPayload(payload) as fhir4.Bundle) : payload;
        const issues = validateMessage(parsed, kind, profile);
        logTool('validate_message', `ok (${issues.length} issues)`);
        return ok({ issues });
      } catch (e) {
        logTool('validate_message', 'error');
        return fail(e);
      }
    },
  );

  server.registerTool(
    'explain_error',
    {
      description: 'Convierte un issue de validación en explicación humana: ubicación legible, significado de tablas HL7 y una pista accionable.',
      inputSchema: { issue: issueSchema },
    },
    ({ issue }) => {
      try {
        return ok(explainError(issue));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

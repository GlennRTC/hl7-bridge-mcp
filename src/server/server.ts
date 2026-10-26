import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { errorPayload, Hl7BridgeError } from '../errors/index.js';
import { loadMaps, mapV2ToFhir } from '../mapper/index.js';
import { parseHl7v2 } from '../parser/index.js';
import {
  explainError,
  issueSchema,
  parseJsonPayload,
  validateFhir,
  validateMessage,
  type Explanation,
  type Issue,
} from '../validator/index.js';
import { logMessageDebug, makeLogger, type Logger } from './log.js';

// Leído del disco una vez por proceso: la descripción de mapId debe listar los mapas
// reales, no una copia que se desincroniza. Si maps/ falta, falla al arrancar (ruidoso).
const MAP_IDS = loadMaps()
  .map((fhirMap) => (fhirMap.profile !== undefined ? `${fhirMap.id} (perfil ${fhirMap.profile}, requiere mapId explícito)` : fhirMap.id))
  .join(', ');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const errCode = (error: unknown): string => (error instanceof Hl7BridgeError ? error.code : 'INTERNAL');

function fail(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: errorPayload(error) }, null, 2) }], isError: true };
}

/**
 * Sampling MCP: pide al LLM del *cliente* una explicación en lenguaje natural, sin API key en el
 * servidor. Solo viaja el issue ya explicado (código/ubicación/mensaje del validador), nunca el
 * mensaje clínico crudo. Es opcional: sin capability o ante cualquier fallo devuelve undefined y
 * la respuesta determinista sigue siendo válida.
 */
async function narrate(server: McpServer, log: Logger, issue: Issue, explanation: Explanation): Promise<string | undefined> {
  if (!server.server.getClientCapabilities()?.sampling) return undefined;
  try {
    const res = await server.server.createMessage({
      systemPrompt:
        'Eres un experto en interoperabilidad HL7 v2/FHIR. Explica en 2-3 frases, en español, qué significa el issue de validación y cómo corregirlo. No inventes datos del paciente.',
      messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify({ issue, explanation }) } }],
      maxTokens: 300,
    });
    return res.content.type === 'text' ? res.content.text : undefined;
  } catch {
    log('warning', 'explain_error', 'el sampling falló o fue rechazado; se devuelve la explicación determinista');
    return undefined;
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'hl7-bridge-mcp', version: '0.2.0' }, { capabilities: { logging: {} } });
  const log = makeLogger(server);

  server.registerTool(
    'parse_hl7v2',
    {
      description:
        'Parsea un mensaje HL7 v2 a un AST tipado (segmentos, campos, componentes) con los separadores leídos de MSH-1/MSH-2. Úsala cuando necesites inspeccionar la estructura del mensaje o localizar un segmento/campo concreto; para convertir a FHIR usa map_v2_to_fhir directamente, que ya parsea internamente.',
      inputSchema: {
        message: z
          .string()
          .describe('Mensaje HL7 v2 crudo, con MSH como primer segmento. Acepta separadores de línea \\r, \\n o \\r\\n.'),
      },
    },
    ({ message }) => {
      try {
        logMessageDebug('parse_hl7v2', message);
        const ast = parseHl7v2(message);
        log('info', 'parse_hl7v2', 'mensaje parseado correctamente');
        return ok({ ast });
      } catch (error) {
        log('error', 'parse_hl7v2', `falló: ${errCode(error)}`);
        return fail(error);
      }
    },
  );

  server.registerTool(
    'map_v2_to_fhir',
    {
      description:
        'Mapea un mensaje HL7 v2 a un Bundle FHIR R4 con un mapa declarativo y valida el resultado contra el perfil indicado, explicando cada issue. Llámala siempre que haya que convertir HL7 v2 a FHIR: ya devuelve el bundle y la validación explicada, así que no hace falta encadenar validate_message ni explain_error después.',
      inputSchema: {
        message: z.string().describe('Mensaje HL7 v2 crudo a convertir.'),
        mapId: z
          .string()
          .optional()
          .describe(`Mapa declarativo a usar. Si se omite, se resuelve por MSH-9 entre los mapas base. Disponibles: ${MAP_IDS}.`),
        fhirVersion: z.enum(['R4', 'R6']).optional().describe('Versión FHIR de salida. Solo R4 en v0.1; R6 devuelve error tipado.'),
        profile: z
          .enum(['us-core', 'cl-core', 'co-core'])
          .optional()
          .describe('Perfil contra el que validar el bundle resultante. Por defecto us-core; cl-core/co-core son packs nacionales.'),
      },
    },
    async ({ message, mapId, fhirVersion, profile }, extra) => {
      // Progreso MCP: solo si el cliente pidió seguimiento (_meta.progressToken).
      const token = extra._meta?.progressToken;
      const progress = (step: number, text: string): Promise<void> =>
        token === undefined
          ? Promise.resolve()
          : extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: step, total: 3, message: text } }).catch(() => {});
      try {
        if (fhirVersion === 'R6') {
          throw new Hl7BridgeError('UNSUPPORTED_VERSION', 'fhirVersion', 'FHIR R6 aún no soportado en v0.1; usa R4.');
        }
        logMessageDebug('map_v2_to_fhir', message);
        // Las degradaciones del mapeo (mapa forzado, segmentos ignorados) van primero:
        // condicionan cómo leer los issues de perfil que vienen después.
        const issues: Issue[] = [];
        await progress(0, 'Parseando y mapeando el mensaje HL7 v2 a FHIR…');
        const bundle = mapV2ToFhir(message, { mapId, issues });
        await progress(1, 'Validando el Bundle contra el perfil…');
        issues.push(...validateFhir(bundle, profile));
        await progress(2, 'Explicando los issues de validación…');
        const explained = issues.map(explainError);
        await progress(3, 'Conversión completada.');
        log('info', 'map_v2_to_fhir', `conversión completada (${issues.length} issues)`);
        return ok({ bundle, validation: { issues, explained } });
      } catch (error) {
        log('error', 'map_v2_to_fhir', `falló: ${errCode(error)}`);
        return fail(error);
      }
    },
  );

  server.registerTool(
    'validate_message',
    {
      description:
        'Valida un mensaje HL7 v2 (segmentos/campos requeridos) o un Bundle FHIR contra un perfil y devuelve issues estructurados. Úsala cuando solo quieras comprobar si un payload cumple, sin convertirlo: si vas a mapear v2 a FHIR, map_v2_to_fhir ya valida el resultado.',
      inputSchema: {
        payload: z.string().describe('Mensaje HL7 v2 crudo, o un Bundle/recurso FHIR serializado como JSON, según kind.'),
        kind: z.enum(['hl7v2', 'fhir']).describe('Qué contiene payload: "hl7v2" para un mensaje crudo, "fhir" para JSON.'),
        profile: z
          .enum(['us-core', 'cl-core', 'co-core'])
          .optional()
          .describe('Perfil FHIR a aplicar cuando kind es "fhir". Por defecto us-core; se ignora para hl7v2.'),
      },
    },
    ({ payload, kind, profile }) => {
      try {
        const parsed = kind === 'fhir' ? (parseJsonPayload(payload) as fhir4.Bundle) : payload;
        const issues = validateMessage(parsed, kind, profile);
        log('info', 'validate_message', `validación completada (${issues.length} issues)`);
        return ok({ issues });
      } catch (error) {
        log('error', 'validate_message', `falló: ${errCode(error)}`);
        return fail(error);
      }
    },
  );

  server.registerTool(
    'explain_error',
    {
      description:
        'Convierte un issue de validación en explicación humana: ubicación legible, significado de tablas HL7 y una pista accionable. Úsala para un issue suelto que ya tengas (de validate_message o de un log externo); las respuestas de map_v2_to_fhir ya vienen explicadas.',
      inputSchema: { issue: issueSchema.describe('Issue tal como lo devuelve validate_message, con severity, code, location y message.') },
    },
    async ({ issue }) => {
      try {
        const explanation = explainError(issue);
        const narrative = await narrate(server, log, issue, explanation);
        return ok(narrative === undefined ? explanation : { ...explanation, narrative });
      } catch (error) {
        log('error', 'explain_error', `falló: ${errCode(error)}`);
        return fail(error);
      }
    },
  );

  return server;
}

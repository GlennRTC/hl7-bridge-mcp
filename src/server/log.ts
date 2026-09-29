import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const PHI_SEGMENTS = new Set(['PID', 'NK1', 'GT1']);

/** Redacta el contenido de segmentos con datos de paciente (PID/NK1/GT1) para logging seguro. */
export function redactMessage(raw: string): string {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => (PHI_SEGMENTS.has(line.slice(0, 3)) ? `${line.slice(0, 3)}|[REDACTED]` : line))
    .join('\n');
}

export type Level = 'debug' | 'info' | 'warning' | 'error';

/**
 * Logging MCP (notifications/message) + espejo en stderr. Solo viajan resultados y códigos de
 * error, nunca contenido del mensaje clínico (RNF1). Si el cliente no escucha, se ignora.
 */
export type Logger = (level: Level, tool: string, msg: string) => void;

export function makeLogger(server: McpServer): Logger {
  return (level, tool, msg) => {
    console.error(`[${level}] ${tool}: ${msg}`);
    server.sendLoggingMessage({ level, logger: tool, data: msg }).catch(() => {});
  };
}

/** Cuerpo del mensaje solo con DEBUG_HL7 activo y siempre redactado (RNF1). */
export function logMessageDebug(tool: string, raw: string): void {
  if (process.env.DEBUG_HL7) console.error(`[debug] ${tool} payload:\n${redactMessage(raw)}`);
}

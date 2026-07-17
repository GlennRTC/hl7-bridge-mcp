const PHI_SEGMENTS = new Set(['PID', 'NK1', 'GT1']);

/** Redacta el contenido de segmentos con datos de paciente (PID/NK1/GT1) para logging seguro. */
export function redactMessage(raw: string): string {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => (PHI_SEGMENTS.has(line.slice(0, 3)) ? `${line.slice(0, 3)}|[REDACTED]` : line))
    .join('\n');
}

/** Logs a stderr: en transporte stdio, stdout está reservado al protocolo MCP. */
export function logTool(tool: string, outcome: string): void {
  console.error(`[info] ${tool}: ${outcome}`);
}

/** Cuerpo del mensaje solo con DEBUG_HL7 activo y siempre redactado (RNF1). */
export function logMessageDebug(tool: string, raw: string): void {
  if (process.env.DEBUG_HL7) console.error(`[debug] ${tool} payload:\n${redactMessage(raw)}`);
}

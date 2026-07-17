/**
 * Error tipado del proyecto. Nunca `throw new Error("string suelto")`.
 * `location` apunta al origen del fallo: segmento-campo-componente HL7 v2
 * (ej. "PID-3[1].1") o FHIRPath (ej. "Patient.identifier[0].value").
 */
export class Hl7BridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly location: string,
    public readonly humanMessage: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${location}: ${humanMessage}`, options);
    this.name = 'Hl7BridgeError';
  }
}

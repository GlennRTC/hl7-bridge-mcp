/** Metadatos de campos v2 para explicación: nombre legible y tabla HL7 asociada. */
export const FIELD_CATALOG: Record<string, { name: string; table?: string }> = {
  'MSH-9': { name: 'Tipo de mensaje' },
  'MSH-10': { name: 'ID de control del mensaje' },
  'PID-3': { name: 'Lista de identificadores del paciente' },
  'PID-5': { name: 'Nombre del paciente' },
  'PID-7': { name: 'Fecha de nacimiento' },
  'PID-8': { name: 'Sexo administrativo', table: '0001' },
  'PV1-2': { name: 'Clase de paciente', table: '0004' },
  'ORC-1': { name: 'Función de control de la orden' },
  'OBR-4': { name: 'Identificador universal de servicio (código de estudio)' },
  'OBX-2': { name: 'Tipo de valor de la observación', table: '0125' },
  'OBX-3': { name: 'Identificador de la observación' },
  'OBX-11': { name: 'Estado del resultado de la observación', table: '0085' },
};

/** Segmentos y campos requeridos por tipo de mensaje (subconjunto mínimo v0.1). */
export const V2_REQUIREMENTS: Record<string, { segments: string[]; fields: string[] }> = {
  'ADT^A01': { segments: ['MSH', 'EVN', 'PID', 'PV1'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'PID-5', 'PV1-2'] },
  'ORU^R01': { segments: ['MSH', 'PID', 'OBR', 'OBX'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'OBX-2', 'OBX-3', 'OBX-11'] },
  'ORM^O01': { segments: ['MSH', 'PID', 'ORC', 'OBR'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'ORC-1', 'OBR-4'] },
};

/**
 * Elementos must-support de cardinalidad mínima 1 (subconjunto US Core).
 * Solo los obligatorios: un elemento ausente aquí es error de perfil, no aviso.
 */
export const FHIR_PROFILE: Record<string, { path: string; message: string }[]> = {
  Patient: [
    { path: 'identifier', message: 'US Core Patient requiere al menos un identifier.' },
    { path: 'name', message: 'US Core Patient requiere al menos un name.' },
    { path: 'gender', message: 'US Core Patient requiere gender.' },
  ],
  Observation: [
    { path: 'status', message: 'US Core Observation requiere status.' },
    { path: 'category', message: 'US Core Observation requiere category.' },
    { path: 'code', message: 'US Core Observation requiere code.' },
    { path: 'subject', message: 'US Core Observation requiere subject.' },
  ],
};

export const HINTS: Record<string, string> = {
  MISSING_SEGMENT: 'Añade el segmento ausente antes de reenviar el mensaje.',
  MISSING_FIELD: 'Completa el campo requerido; el destino suele rechazar el mensaje sin él.',
  PROFILE_REQUIRED: 'El perfil FHIR exige este elemento (must-support). Ajusta el mapa o el mensaje de origen para poblarlo.',
  CODING_NO_SYSTEM: 'Añade el system URI del código (ej. http://loinc.org). En HL7 v2 suele venir en el 3.er componente (tabla 0396); si es local, registra su URI en el mapa.',
  CODING_EMPTY: 'El Coding no tiene code; revisa el componente de origen en el mensaje v2.',
};

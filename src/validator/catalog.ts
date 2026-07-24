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
  'SPM-4': { name: 'Tipo de espécimen', table: '0487' },
};

/** Segmentos y campos requeridos por tipo de mensaje (subconjunto mínimo v0.1). */
export const V2_REQUIREMENTS: Record<string, { segments: string[]; fields: string[]; notes?: Record<string, string> }> = {
  'ADT^A01': { segments: ['MSH', 'EVN', 'PID', 'PV1'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'PID-5', 'PV1-2'] },
  'ORU^R01': { segments: ['MSH', 'PID', 'OBR', 'OBX'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'OBX-2', 'OBX-3', 'OBX-11'] },
  'ORM^O01': { segments: ['MSH', 'PID', 'ORC', 'OBR'], fields: ['MSH-9', 'MSH-10', 'PID-3', 'ORC-1', 'OBR-4'] },
  // OUL^R22 (Unsolicited Specimen Oriented Observation). Núcleo por spec v2.5.1: SPM (R, repetible)
  // → OBR (R) → OBX (R); PID es opcional. Decisiones validadas (spec v2.5.1 + v2-to-FHIR IG +
  // auditoría clínica), no adivinadas:
  //  - PID/PID-3 se exigen a propósito: sin Patient, US Core Observation.subject (1..1) no se puede
  //    poblar; los especímenes de QC/no-paciente (SPM-11 ≠ P) quedan fuera de v0.1 (ver notes.PID).
  //  - OBR es obligatorio por spec pero NO se exige aquí: el mapa aún no lo consume (DiagnosticReport
  //    diferido); exigir un segmento que ignoramos rechazaría mensajes traducibles sin motivo accionable.
  //  - SPM-4 (Specimen Type) es R en la propia spec v2.5.1, no una imposición de perfil FHIR.
  'OUL^R22': {
    segments: ['MSH', 'PID', 'SPM', 'OBX'],
    fields: ['MSH-9', 'MSH-10', 'PID-3', 'SPM-4', 'OBX-2', 'OBX-3', 'OBX-11'],
    notes: {
      PID: 'Esta versión solo soporta especímenes asociados a paciente (US Core Observation exige subject 1..1); los especímenes de QC/no-paciente (SPM-11 ≠ P) quedan fuera del alcance de v0.1.',
    },
  },
};

/** Regla de perfil: `expr` (FHIRPath) debe cumplirse; `location` señala el elemento; incumplir = error. */
export interface ProfileRule {
  expr: string;
  location: string;
  message: string;
}

/**
 * Invariantes US Core (subconjunto) como expresiones FHIRPath evaluadas contra el
 * modelo R4: value[x] resuelve valueQuantity/valueString y .where() comprueba
 * slices reales, no solo presencia de un elemento. `expr` es la condición que
 * debe cumplirse; `location` señala el elemento para el issue. Incumplir = error.
 */
export const FHIR_PROFILE: Record<string, ProfileRule[]> = {
  Patient: [
    { expr: 'identifier.where(system.exists() and value.exists()).exists()', location: 'identifier', message: 'US Core Patient requiere un identifier con system y value.' },
    { expr: 'name.where(family.exists() or given.exists()).exists()', location: 'name', message: 'US Core Patient requiere un name con family o given.' },
    { expr: 'gender.exists()', location: 'gender', message: 'US Core Patient requiere gender.' },
  ],
  Observation: [
    { expr: 'status.exists()', location: 'status', message: 'US Core Observation requiere status.' },
    { expr: "category.coding.where(code='laboratory').exists()", location: 'category', message: 'US Core Observation (lab) requiere category con code laboratory.' },
    { expr: 'code.coding.exists()', location: 'code', message: 'US Core Observation requiere code.coding.' },
    { expr: 'subject.reference.exists()', location: 'subject', message: 'US Core Observation requiere subject.' },
    { expr: 'value.exists() or dataAbsentReason.exists()', location: 'value[x]', message: 'US Core Observation requiere value[x] o dataAbsentReason.' },
  ],
};

/**
 * CL Core — CorePacienteCl (https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl).
 * Reglas estructurales derivadas de las cardinalidades min>=1 del differential real (v1.8.5),
 * NO inventadas: identifier 1..*, name(NombreOficial).family 1..1, name.given 1..*. Mismo nivel
 * que US Core: estructural + presencia must-support, NO binding/slicing normativo completo.
 * CL Core no perfila Observation ni DiagnosticReport → las observaciones de ORU no tienen regla
 * nacional (siguen FHIR base).
 */
export const CL_CORE_PROFILE: Record<string, ProfileRule[]> = {
  Patient: [
    { expr: 'identifier.exists()', location: 'identifier', message: 'CL Core (CorePacienteCl) requiere al menos un identifier (1..*).' },
    { expr: 'name.where(family.exists()).exists()', location: 'name.family', message: 'CL Core (CorePacienteCl) requiere name.family (NombreOficial, 1..1).' },
    { expr: 'name.where(given.exists()).exists()', location: 'name.given', message: 'CL Core (CorePacienteCl) requiere name.given (NombreOficial, 1..*).' },
  ],
};

/**
 * CO Core — PatientCO (http://co.fhir.guide/core/StructureDefinition/PatientCO).
 * Reglas derivadas de las cardinalidades min>=1 del differential real (v0.1.0, local dev build):
 * identifier 1..*, active 1..1 MS, name(OfficialPatientName).family/given, gender 1..1 MS,
 * birthDate 1..1 MS, address(HomeAddress) con city/state/country 1..1. Mismo nivel que US Core
 * (estructural + must-support, no normativa completa). CO Core tampoco perfila Observation/
 * DiagnosticReport. ADVERTENCIA: v0.1.0 local dev build — estructura puede cambiar sin aviso.
 */
export const CO_CORE_PROFILE: Record<string, ProfileRule[]> = {
  Patient: [
    { expr: 'identifier.exists()', location: 'identifier', message: 'CO Core (PatientCO) requiere al menos un identifier (1..*).' },
    { expr: 'active.exists()', location: 'active', message: 'CO Core (PatientCO) requiere active (1..1, must-support).' },
    { expr: 'name.where(family.exists()).exists()', location: 'name.family', message: 'CO Core (PatientCO) requiere name.family (OfficialPatientName, 1..1).' },
    { expr: 'name.where(given.exists()).exists()', location: 'name.given', message: 'CO Core (PatientCO) requiere name.given (OfficialPatientName, 1..*).' },
    { expr: 'gender.exists()', location: 'gender', message: 'CO Core (PatientCO) requiere gender (1..1, must-support).' },
    { expr: 'birthDate.exists()', location: 'birthDate', message: 'CO Core (PatientCO) requiere birthDate (1..1, must-support).' },
    { expr: 'address.where(city.exists() and state.exists() and country.exists()).exists()', location: 'address', message: 'CO Core (PatientCO) requiere address (HomeAddress) con city, state y country (1..1).' },
  ],
};

export const HINTS: Record<string, string> = {
  MISSING_SEGMENT: 'Añade el segmento ausente antes de reenviar el mensaje.',
  MISSING_FIELD: 'Completa el campo requerido; el destino suele rechazar el mensaje sin él.',
  PROFILE_REQUIRED: 'El perfil FHIR exige este elemento (must-support). Ajusta el mapa o el mensaje de origen para poblarlo.',
  CODING_NO_SYSTEM: 'Añade el system URI del código (ej. http://loinc.org). En HL7 v2 suele venir en el 3.er componente (tabla 0396); si es local, registra su URI en el mapa.',
  CODING_EMPTY: 'El Coding no tiene code; revisa el componente de origen en el mensaje v2.',
};

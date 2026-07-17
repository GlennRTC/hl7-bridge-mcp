// ponytail: subconjunto mínimo de tablas HL7; ampliar tabla a tabla cuando un mapa o explicación lo necesite.
export const HL7_TABLES: Record<string, Record<string, string>> = {
  // Sexo administrativo
  '0001': { F: 'Female', M: 'Male', O: 'Other', U: 'Unknown', A: 'Ambiguous', N: 'Not applicable' },
  // Clase de paciente (PV1-2)
  '0004': { B: 'Obstetrics', E: 'Emergency', I: 'Inpatient', O: 'Outpatient', P: 'Preadmit', R: 'Recurring patient' },
  // Estado del resultado de observación (OBX-11)
  '0085': { C: 'Corrected', D: 'Deleted', F: 'Final', I: 'Pending', P: 'Preliminary', X: 'Cannot be obtained' },
  // Tipo de valor (OBX-2)
  '0125': { CE: 'Coded entry', DT: 'Date', NM: 'Numeric', SN: 'Structured numeric', ST: 'String', TM: 'Time', TS: 'Timestamp', TX: 'Text' },
};

/** Devuelve la descripción del código en la tabla, o undefined si no está en el subconjunto incluido. */
export function resolveTable(tableId: string, code: string): string | undefined {
  return HL7_TABLES[tableId]?.[code];
}

import { resolveTable } from '../parser/tables.js';
import { FIELD_CATALOG, HINTS } from './catalog.js';
import type { Issue } from './index.js';

export interface Explanation {
  humanMessage: string;
  location: string;
  hint: string;
}

/**
 * Convierte un Issue en explicación humana. Enriquece la ubicación con el nombre
 * legible del campo y, si el mensaje del issue cita un valor codificado de una
 * tabla HL7 conocida, resuelve su significado (ej. OBX-11 'F' → "Final").
 */
export function explainError(issue: Issue): Explanation {
  const fieldKey = issue.location.replace(/\[\d+\]/g, '').split('.')[0]!;
  const info = FIELD_CATALOG[fieldKey];
  const location = info ? `${issue.location} (${info.name})` : issue.location;

  let humanMessage = issue.message;
  if (info?.table) {
    const value = /'([^']*)'/.exec(issue.message)?.[1];
    const meaning = value !== undefined ? resolveTable(info.table, value) : undefined;
    if (meaning) humanMessage += ` El valor '${value}' significa "${meaning}" (tabla HL7 ${info.table}).`;
  }

  return { humanMessage, location, hint: HINTS[issue.code] ?? 'Revisa el mensaje de origen contra la especificación del perfil.' };
}

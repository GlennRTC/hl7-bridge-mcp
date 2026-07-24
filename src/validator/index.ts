import fhirpath from 'fhirpath';
import fhirR4Model from 'fhirpath/fhir-context/r4/index.js';
import { Hl7BridgeError } from '../errors/index.js';
import { messageTypeOf, resolveV2Path } from '../mapper/index.js';
import { parseHl7v2 } from '../parser/index.js';
import type { Hl7Message } from '../parser/types.js';
import { V2_REQUIREMENTS } from './catalog.js';
import { PROFILE_RULES, type ProfileId } from './profilePack.js';

export type { Explanation } from './explain.js';
export { explainError } from './explain.js';

export type Severity = 'error' | 'warning' | 'information';

export interface Issue {
  severity: Severity;
  code: string;
  /** Segmento-campo v2 (ej. "OBX-11") o FHIRPath (ej. "Observation.category"). */
  location: string;
  message: string;
}

export function validateV2(input: string | Hl7Message): Issue[] {
  const msg = typeof input === 'string' ? parseHl7v2(input) : input;
  const type = messageTypeOf(msg);
  const req = V2_REQUIREMENTS[type];
  if (!req) {
    return [{ severity: 'warning', code: 'NO_PROFILE', location: 'MSH-9', message: `No hay reglas de validación para el tipo de mensaje "${type}".` }];
  }
  const issues: Issue[] = [];
  for (const seg of req.segments) {
    if (!msg.segments.some((s) => s.name === seg)) {
      const note = req.notes?.[seg];
      issues.push({ severity: 'error', code: 'MISSING_SEGMENT', location: seg, message: `Falta el segmento requerido ${seg} para ${type}.${note ? ` ${note}` : ''}` });
    }
  }
  for (const field of req.fields) {
    const seg = field.split('-')[0]!;
    if (!msg.segments.some((s) => s.name === seg)) continue; // ya reportado como MISSING_SEGMENT
    if (resolveV2Path(msg, field) === undefined) {
      issues.push({ severity: 'error', code: 'MISSING_FIELD', location: field, message: `Falta el campo requerido ${field} para ${type}.` });
    }
  }
  return issues;
}

export function validateFhir(input: fhir4.Bundle | fhir4.FhirResource, profile: ProfileId = 'us-core'): Issue[] {
  const issues: Issue[] = [];
  const profileRules = PROFILE_RULES[profile];
  // Un Bundle se valida por entradas; un recurso suelto se valida tal cual.
  const resources = input.resourceType === 'Bundle' ? (input.entry ?? []).map((e) => e.resource) : [input];
  for (const resource of resources) {
    if (!resource) continue;
    const rules = profileRules[resource.resourceType];
    if (!rules) continue;
    for (const rule of rules) {
      // evaluate() sin opción async es síncrono; el modelo R4 resuelve value[x] y
      // los slices de .where(). El tipo union del resultado obliga al cast.
      const present = (fhirpath.evaluate(resource as object, rule.expr, undefined, fhirR4Model) as unknown[])[0] === true;
      if (!present) {
        issues.push({ severity: 'error', code: 'PROFILE_REQUIRED', location: `${resource.resourceType}.${rule.location}`, message: rule.message });
      }
    }
    issues.push(...codingIssues(resource, resource.resourceType));
  }
  return issues;
}

/**
 * Recorre los arrays `coding` del recurso. Un Coding con `code` pero sin `system`
 * es ambiguo entre sistemas de codificación → warning; sin `code` no aporta nada → error.
 * Severidad conservadora (no bloquea): un perfil que exija el binding lo escala aparte.
 */
function codingIssues(node: unknown, path: string): Issue[] {
  const issues: Issue[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => issues.push(...codingIssues(v, `${path}[${i}]`)));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'coding' && Array.isArray(value)) {
        value.forEach((c: { system?: string; code?: string }, i) => {
          const location = `${path}.coding[${i}]`;
          if (!c.code) {
            issues.push({ severity: 'error', code: 'CODING_EMPTY', location, message: 'Un Coding sin code no identifica ningún concepto.' });
          } else if (!c.system) {
            issues.push({ severity: 'warning', code: 'CODING_NO_SYSTEM', location, message: `Coding con code "${c.code}" pero sin system: el código es ambiguo entre sistemas de codificación.` });
          }
        });
      }
      issues.push(...codingIssues(value, `${path}.${key}`));
    }
  }
  return issues;
}

export type ValidateKind = 'hl7v2' | 'fhir';

/**
 * Entrada de la tool `validate_message`. `payload` es texto crudo (v2) o Bundle JSON (fhir).
 * `profile` selecciona el pack FHIR nacional (solo aplica a kind "fhir"; en "hl7v2" se ignora).
 */
export function validateMessage(
  payload: string | Hl7Message | fhir4.Bundle | fhir4.FhirResource,
  kind: ValidateKind,
  profile: ProfileId = 'us-core',
): Issue[] {
  if (kind === 'hl7v2') {
    if (typeof payload !== 'string' && !('segments' in payload)) {
      throw new Hl7BridgeError('VALIDATE_INPUT', 'payload', 'kind "hl7v2" espera un mensaje HL7 v2 (texto o AST).');
    }
    return validateV2(payload);
  }
  if (typeof payload === 'string' || !('resourceType' in payload)) {
    throw new Hl7BridgeError('VALIDATE_INPUT', 'payload', 'kind "fhir" espera un Bundle FHIR.');
  }
  return validateFhir(payload, profile);
}

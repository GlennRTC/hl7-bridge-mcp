import { Hl7BridgeError } from '../errors/index.js';
import type { Hl7Message, Segment } from '../parser/types.js';

export interface TransformCtx {
  /** Ocurrencia del segmento ancla del recurso (si lo hay). */
  segment?: Segment;
  message: Hl7Message;
}

/** Devuelve el valor a escribir, o un objeto a fusionar en la raíz del recurso cuando `to: "."`. */
export type Transform = (raw: string, ctx: TransformCtx) => unknown;

const comp = (seg: Segment | undefined, field: number, component = 1): string =>
  seg?.fields[field - 1]?.repetitions[0]?.components[component - 1]?.subcomponents[0] ?? '';

/** Tabla 0396 (sistema de codificación v2) → system URI FHIR. No registrado → undefined (no se adivina). */
const codingSystemUri = (raw: string): string | undefined =>
  ({ LN: 'http://loinc.org', SCT: 'http://snomed.info/sct' })[raw];

/** Coding a partir de un triplete CWE (código, texto, sistema-0396). Código vacío → undefined. */
const cweCoding = (code: string, text: string, systemCode: string): fhir4.Coding | undefined => {
  if (code === '') return undefined;
  const coding: fhir4.Coding = { code };
  if (text) coding.display = text;
  const system = codingSystemUri(systemCode);
  if (system) coding.system = system;
  return coding;
};

/**
 * Tabla 0119 (ORC-1, Order Control) → ServiceRequest.status. Verbatim de
 * HL7/v2-to-fhir `Table HL70119 to Request Status.fsh`; los códigos "unmatched"
 * del IG no figuran y caen al default "unknown".
 */
const ORDER_CONTROL_STATUS: Record<string, string> = {
  NW: 'active', OK: 'active', CA: 'active', HD: 'active', RL: 'active', RO: 'active', RQ: 'active', PR: 'active', PY: 'active', AF: 'active',
  CR: 'revoked', DC: 'revoked', DF: 'revoked', DR: 'revoked', OC: 'revoked', OD: 'revoked',
  HR: 'on-hold', OH: 'on-hold',
  FU: 'completed',
};

/** Tabla 0004 (PV1-2) → v3-ActCode. Fuente: `Table HL70004 to V3 ActCode.fsh`. */
const PATIENT_CLASS_ACTCODE: Record<string, string> = { E: 'EMER', I: 'IMP', O: 'AMB', P: 'PRENC' };
/** R/B/C/N/U no tienen equivalente ActCode; el IG los devuelve sobre v2-0004 (decisión deliberada). */
const PATIENT_CLASS_PASSTHROUGH = new Set(['R', 'B', 'C', 'N', 'U']);
const V3_ACTCODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const V2_0004 = 'http://terminology.hl7.org/CodeSystem/v2-0004';

/** Tabla 0123 (OBR-25) → DiagnosticReport.status. Fuente: `Table HL70123[Queries] to Diagnostic Report Status.fsh`. */
const REPORT_STATUS: Record<string, string> = {
  O: 'registered', I: 'registered', S: 'registered', P: 'preliminary', R: 'partial', F: 'final', C: 'corrected', X: 'cancelled',
};

export const transforms: Record<string, Transform> = {
  /**
   * TS HL7 (YYYY[MM[DD[HHMM[SS]]]][±ZZZZ]) → ISO 8601.
   * ponytail: si el origen no trae offset, la salida tampoco; la política de zona
   * horaria por feed es TODO(mapeo) y la validación de perfil lo señalará.
   */
  hl7_datetime: (raw) => {
    const m = /^(\d{4})(\d{2})?(\d{2})?(?:(\d{2})(\d{2})?(\d{2})?)?(?:\.\d+)?([+-]\d{4})?$/.exec(raw);
    if (!m) {
      throw new Hl7BridgeError('MAP_TRANSFORM', 'hl7_datetime', `"${raw}" no es una fecha/hora HL7 válida (YYYY[MM[DD[HHMM[SS]]]][±ZZZZ]).`);
    }
    const [, y, mo, d, h, mi, s, tz] = m;
    let out = y!;
    if (mo) out += `-${mo}`;
    if (d) out += `-${d}`;
    if (h) {
      out += `T${h}:${mi ?? '00'}:${s ?? '00'}`;
      if (tz) out += `${tz.slice(0, 3)}:${tz.slice(3)}`;
    }
    return out;
  },

  /** Tabla 0001 → Patient.gender (AdministrativeGender). */
  hl7_sex: (raw) =>
    ({ M: 'male', F: 'female', O: 'other', A: 'other', U: 'unknown', N: 'unknown' })[raw] ?? 'unknown',

  /** Tabla 0085 (OBX-11) → Observation.status. Código no reconocido → "unknown" (válido en FHIR, no silencioso). */
  hl7_result_status: (raw) =>
    ({ F: 'final', P: 'preliminary', C: 'corrected', X: 'cancelled', D: 'entered-in-error', I: 'registered' })[raw] ?? 'unknown',

  /** Tabla 0396 (OBX-3.3 / OBR-4.3) → system URI de un Coding. */
  hl7_coding_system: (raw) => codingSystemUri(raw),

  /**
   * Tabla 0119 (ORC-1) → ServiceRequest.status.
   * TODO(mapeo): ORC-5 (tabla 0038) debería tener precedencia cuando está poblado,
   * pero el v2-to-FHIR IG no publica ConceptMap para 0038; requiere validación de Glenn.
   */
  hl7_order_status: (raw) => ORDER_CONTROL_STATUS[raw] ?? 'unknown',

  /**
   * Tabla 0004 (PV1-2) → Encounter.class (Coding). E/I/O/P → v3-ActCode;
   * R/B/C/N/U se devuelven sobre v2-0004 (el IG no les da equivalente ActCode).
   * Código fuera de tabla → undefined: class se omite, no se adivina.
   */
  hl7_patient_class: (raw) => {
    const actCode = PATIENT_CLASS_ACTCODE[raw];
    if (actCode) return { system: V3_ACTCODE, code: actCode };
    if (PATIENT_CLASS_PASSTHROUGH.has(raw)) return { system: V2_0004, code: raw };
    return undefined;
  },

  /** Tabla 0123 (OBR-25) → DiagnosticReport.status. Desconocido/unmatched → "unknown". */
  hl7_report_status: (raw) => REPORT_STATUS[raw] ?? 'unknown',

  /** OBX-2 decide el tipo de Observation.value[x]; OBX-6 aporta la unidad para NM. */
  obx_value_by_obx2: (raw, { segment }) => {
    const type = comp(segment, 2);
    switch (type) {
      case 'NM': {
        const quantity: fhir4.Quantity = { value: Number(raw) };
        const unit = comp(segment, 6);
        if (unit) quantity.unit = unit;
        return { valueQuantity: quantity };
      }
      case 'ST':
      case 'TX':
        return { valueString: raw };
      case 'CE':
      case 'CWE': {
        // coding[0] = CWE.1/2/3; coding[1] = CWE.4/5/6 (coding alternativo), ambos vía tabla 0396.
        const coding = [
          cweCoding(comp(segment, 5, 1), comp(segment, 5, 2), comp(segment, 5, 3)),
          cweCoding(comp(segment, 5, 4), comp(segment, 5, 5), comp(segment, 5, 6)),
        ].filter((c): c is fhir4.Coding => c !== undefined);
        return { valueCodeableConcept: { coding } };
      }
      default:
        throw new Hl7BridgeError('MAP_TRANSFORM', 'OBX-2', `Tipo de valor "${type}" no soportado por obx_value_by_obx2 (soportados: NM, ST, TX, CE, CWE).`);
    }
  },
};

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

  /** Tabla 0396 (OBX-3.3) → system URI de Observation.code. */
  hl7_coding_system: (raw) => codingSystemUri(raw),

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
        const coding: fhir4.Coding = { code: comp(segment, 5, 1) };
        const display = comp(segment, 5, 2);
        if (display) coding.display = display;
        const system = codingSystemUri(comp(segment, 5, 3)); // OBX-5.3, tabla 0396
        if (system) coding.system = system;
        // TODO(mapeo): CWE-4/5/6 (coding alternativo/traducción) → coding[1] con el mismo lookup; requiere validación de Glenn.
        return { valueCodeableConcept: { coding: [coding] } };
      }
      default:
        throw new Hl7BridgeError('MAP_TRANSFORM', 'OBX-2', `Tipo de valor "${type}" no soportado por obx_value_by_obx2 (soportados: NM, ST, TX, CE, CWE).`);
    }
  },
};

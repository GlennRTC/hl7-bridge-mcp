import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { Hl7BridgeError } from '../errors/index.js';
import { parseHl7v2 } from '../parser/index.js';
import type { Hl7Message, Segment } from '../parser/types.js';
import { transforms } from './transforms.js';

export { transforms } from './transforms.js';

const entrySchema = z.object({
  to: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
  ref: z.string().optional(),
  refAll: z.string().optional(),
  transform: z.string().optional(),
});
type MapEntry = z.infer<typeof entrySchema>;
const resourceSchema = z.object({
  type: z.string(),
  from: z.string().optional(),
  map: z.array(entrySchema),
});
export const mapSchema = z.object({
  id: z.string(),
  messageType: z.string(),
  target: z.string(),
  resources: z.array(resourceSchema),
  notes: z.string().optional(),
});
export type Hl7FhirMap = z.infer<typeof mapSchema>;

export function loadMap(filePath: string): Hl7FhirMap {
  try {
    return mapSchema.parse(parseYaml(readFileSync(filePath, 'utf8')));
  } catch (e) {
    if (e instanceof z.ZodError) {
      const detail = e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Hl7BridgeError('MAP_INVALID', filePath, `El mapa no cumple el esquema: ${detail}`, { cause: e });
    }
    throw new Hl7BridgeError('MAP_INVALID', filePath, `No se pudo leer el mapa: ${(e as Error).message}`, { cause: e });
  }
}

const DEFAULT_MAPS_DIR = new URL('../../maps/', import.meta.url);

export function loadMaps(base: URL = DEFAULT_MAPS_DIR): Hl7FhirMap[] {
  return readdirSync(base)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => loadMap(new URL(f, base).pathname));
}

const V2_PATH = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\[(\d+)\])?(?:\.(\d+)(?:\.(\d+))?)?$/;

/** Ocurrencia de segmento a usar: el ancla si es del mismo tipo, si no la primera del mensaje. */
function resolveSegment(msg: Hl7Message, segName: string, anchor?: Segment): Segment | undefined {
  return anchor?.name === segName ? anchor : msg.segments.find((s) => s.name === segName);
}

/**
 * Resuelve una ruta v2 ("PID-3[1].1") sobre el mensaje. Si `anchor` es una
 * ocurrencia del mismo segmento que la ruta, se usa esa ocurrencia; si no, la
 * primera del mensaje. Campo vacío → undefined (no se mapea).
 */
export function resolveV2Path(msg: Hl7Message, path: string, anchor?: Segment): string | undefined {
  const m = V2_PATH.exec(path);
  if (!m) {
    throw new Hl7BridgeError('MAP_INVALID_PATH', path, 'Ruta v2 inválida; formato esperado: SEG-campo[repetición].componente.subcomponente (ej. "PID-3[1].1").');
  }
  const [, segName, field, rep = '1', comp = '1', sub = '1'] = m;
  const segment = resolveSegment(msg, segName!, anchor);
  const value = segment?.fields[Number(field) - 1]?.repetitions[Number(rep) - 1]?.components[Number(comp) - 1]?.subcomponents[Number(sub) - 1];
  return value === '' ? undefined : value;
}

const REP_WILDCARD_FROM = /^([A-Z][A-Z0-9]{2})-(\d+)\[\*\]/;

/**
 * Expande entradas con `from` comodín (`PID-3[*].1`) a una entrada concreta por
 * repetición existente del campo, sustituyendo `[*]` en `from` (1-based) y en `to`
 * (0-based). Las entradas sin comodín pasan intactas. Un `to` con `[*]` pero sin
 * `from` comodín cae sin expandir y `setPath` lo rechaza (MAP_INVALID_PATH).
 */
function expandRepeatingEntries(entries: MapEntry[], msg: Hl7Message, anchor: Segment | undefined): MapEntry[] {
  const out: MapEntry[] = [];
  for (const entry of entries) {
    const from = entry.from;
    const m = from !== undefined ? REP_WILDCARD_FROM.exec(from) : null;
    if (m === null || from === undefined) {
      out.push(entry);
      continue;
    }
    const [, segName, field] = m;
    const segment = resolveSegment(msg, segName!, anchor);
    const count = segment?.fields[Number(field) - 1]?.repetitions.length ?? 0;
    for (let i = 1; i <= count; i++) {
      out.push({ ...entry, from: from.replace('[*]', `[${i}]`), to: entry.to.replace('[*]', `[${i - 1}]`) });
    }
  }
  return out;
}

const FHIR_TOKEN = /^([A-Za-z]\w*)(?:\[(\d+)\])?$/;

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = path.split('.');
  let node: Record<string, unknown> = target;
  for (let i = 0; i < tokens.length; i++) {
    const m = FHIR_TOKEN.exec(tokens[i]!);
    if (!m) {
      throw new Hl7BridgeError('MAP_INVALID_PATH', path, `Ruta FHIR destino inválida en "${tokens[i]}".`);
    }
    const [, prop, idx] = m;
    const last = i === tokens.length - 1;
    if (idx === undefined) {
      if (last) {
        node[prop!] = value;
      } else {
        node = (node[prop!] ??= {}) as Record<string, unknown>;
      }
    } else {
      const arr = (node[prop!] ??= []) as unknown[];
      if (last) {
        arr[Number(idx)] = value;
      } else {
        node = (arr[Number(idx)] ??= {}) as Record<string, unknown>;
      }
    }
  }
}

export interface MapOptions {
  mapId?: string;
  maps?: Hl7FhirMap[];
  /** Generador de ids para fullUrl; inyectable en tests para salida determinista. */
  newId?: () => string;
}

export function mapV2ToFhir(input: string | Hl7Message, opts: MapOptions = {}): fhir4.Bundle {
  const msg = typeof input === 'string' ? parseHl7v2(input) : input;
  const maps = opts.maps ?? loadMaps();
  const map = opts.mapId !== undefined ? maps.find((m) => m.id === opts.mapId) : findByMessageType(maps, msg);
  if (!map) {
    const wanted = opts.mapId ?? messageTypeOf(msg);
    throw new Hl7BridgeError('MAP_NOT_FOUND', opts.mapId !== undefined ? 'mapId' : 'MSH-9', `No hay mapa para "${wanted}". Mapas disponibles: ${maps.map((m) => m.id).join(', ')}.`);
  }

  const newId = opts.newId ?? randomUUID;
  const entries: fhir4.BundleEntry[] = [];
  const firstByType: Record<string, string> = {};
  const allByType: Record<string, string[]> = {};
  const deferredRefs: { resource: Record<string, unknown>; to: string; ref: string; many: boolean; ownerType: string }[] = [];

  for (const res of map.resources) {
    const occurrences: (Segment | undefined)[] = res.from !== undefined ? msg.segments.filter((s) => s.name === res.from) : [undefined];
    for (const occurrence of occurrences) {
      const resource: Record<string, unknown> = { resourceType: res.type };
      const fullUrl = `urn:uuid:${newId()}`;
      firstByType[res.type] ??= fullUrl;
      (allByType[res.type] ??= []).push(fullUrl);
      for (const entry of expandRepeatingEntries(res.map, msg, occurrence)) {
        if (entry.ref !== undefined) {
          deferredRefs.push({ resource, to: entry.to, ref: entry.ref, many: false, ownerType: res.type });
        } else if (entry.refAll !== undefined) {
          deferredRefs.push({ resource, to: entry.to, ref: entry.refAll, many: true, ownerType: res.type });
        } else if (entry.value !== undefined) {
          setPath(resource, entry.to, entry.value);
        } else if (entry.from !== undefined) {
          const raw = resolveV2Path(msg, entry.from, occurrence);
          if (raw === undefined) continue;
          const value = entry.transform !== undefined ? applyTransform(map.id, entry.transform, raw, occurrence, msg) : raw;
          if (value === undefined) continue;
          if (entry.to === '.') {
            Object.assign(resource, value as Record<string, unknown>);
          } else {
            setPath(resource, entry.to, value);
          }
        } else {
          throw new Hl7BridgeError('MAP_INVALID', map.id, `La entrada hacia "${entry.to}" no tiene "from", "value" ni "ref".`);
        }
      }
      entries.push({ fullUrl, resource: resource as unknown as fhir4.FhirResource });
    }
  }

  for (const { resource, to, ref, many, ownerType } of deferredRefs) {
    if (many) {
      // ponytail: refAll referencia TODAS las ocurrencias de un tipo. Correcto solo si el
      // recurso que lo usa es único; con >1 (p.ej. varios OBR) produciría vínculos cruzados
      // entre grupos. La agrupación real OBR→OBX es el siguiente escalón; hasta entonces, falla ruidosamente.
      if ((allByType[ownerType]?.length ?? 0) > 1) {
        throw new Hl7BridgeError('MAP_INVALID', map.id, `"refAll: ${ref}" en un mapa con más de un "${ownerType}" produciría vínculos cruzados entre grupos (agrupación OBR→OBX aún no implementada). Ver TODO(mapeo) en el YAML.`);
      }
      const targets = allByType[ref];
      if (targets === undefined) {
        throw new Hl7BridgeError('MAP_INVALID', map.id, `"refAll: ${ref}" apunta a un tipo de recurso que el mapa no genera.`);
      }
      setPath(resource, to, targets.map((t) => ({ reference: t })));
    } else {
      const target = firstByType[ref];
      if (target === undefined) {
        throw new Hl7BridgeError('MAP_INVALID', map.id, `"ref: ${ref}" apunta a un tipo de recurso que el mapa no genera.`);
      }
      setPath(resource, to, { reference: target });
    }
  }

  return { resourceType: 'Bundle', type: 'collection', entry: entries };
}

function applyTransform(mapId: string, name: string, raw: string, segment: Segment | undefined, message: Hl7Message): unknown {
  const fn = transforms[name];
  if (!fn) {
    throw new Hl7BridgeError('MAP_INVALID', mapId, `Transformación desconocida "${name}". Disponibles: ${Object.keys(transforms).join(', ')}.`);
  }
  return fn(raw, { segment, message });
}

export function messageTypeOf(msg: Hl7Message): string {
  const msh9 = msg.segments[0]?.fields[8]?.repetitions[0];
  const type = msh9?.components[0]?.subcomponents[0] ?? '';
  const event = msh9?.components[1]?.subcomponents[0] ?? '';
  return event === '' ? type : `${type}^${event}`;
}

function findByMessageType(maps: Hl7FhirMap[], msg: Hl7Message): Hl7FhirMap | undefined {
  const type = messageTypeOf(msg);
  return maps.find((m) => m.messageType === type);
}

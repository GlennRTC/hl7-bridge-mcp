import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hl7BridgeError } from '../errors/index.js';
import { CL_CORE_PROFILE, CO_CORE_PROFILE, FHIR_PROFILE, type ProfileRule } from './catalog.js';

/**
 * Un "profile pack" es una guía de implementación nacional (CL Core, CO Core...) usada como
 * fuente de perfiles FHIR plugables. Existen DOS modos de carga porque las fuentes oficiales
 * de cada país vienen en formatos distintos (no es capricho de diseño):
 *  - npm-package: paquete FHIR npm-style con package.json + .index.json (caso CL Core).
 *  - loose-json: StructureDefinition-*.json sueltos, sin manifiesto (caso CO Core).
 */
export type ProfilePackSource =
  | {
      kind: 'npm-package';
      packageName: string; // ej. "hl7.fhir.cl.clcore"
      packageVersion: string; // ej. "1.8.5"
      path: string; // ruta local al directorio /package
    }
  | {
      kind: 'loose-json';
      path: string; // ruta local al directorio con JSONs sueltos
      declaredPackageName?: string; // ej. "hl7.fhir.co.core" — de la web, no del artefacto
      declaredPackageVersion?: string; // ej. "0.1.0"
      note: string; // por qué no hay manifiesto
    };

export interface ProfilePack {
  id: string; // "cl-core" | "co-core"
  country: string; // "CL" | "CO"
  fhirVersion: '4.0.1';
  source: ProfilePackSource;
  structureDefinitions: string[]; // ids cargados, para trazabilidad
}

/** Identidad + fuente de un pack, sin los ids derivados del disco (los rellena loadProfilePack). */
export type ProfilePackInput = Omit<ProfilePack, 'structureDefinitions'>;

interface FhirPackageManifest {
  name: string;
  version: string;
  fhirVersions?: string[];
}
interface FhirIndexEntry {
  filename: string;
  resourceType: string;
  id: string;
}

/**
 * Carga un pack desde disco y devuelve sus metadatos + los ids de StructureDefinition
 * que contiene (trazabilidad). NO parsea la terminología ni la redistribuye: solo lista
 * qué perfiles trae. La validación real usa reglas curadas (ver PROFILE_RULES), no estos SD.
 */
export function loadProfilePack(input: ProfilePackInput): ProfilePack {
  const dir = input.source.path;
  const structureDefinitions =
    input.source.kind === 'npm-package'
      ? loadNpmPackage(input.source, dir)
      : loadLooseJson(dir);
  return { ...input, structureDefinitions };
}

/** Modo npm-package: confirma nombre/versión/fhirVersion contra el package.json real e indexa vía .index.json. */
function loadNpmPackage(source: Extract<ProfilePackSource, { kind: 'npm-package' }>, dir: string): string[] {
  const manifest = readJson<FhirPackageManifest>(`${dir}/package.json`, source.packageName);
  if (manifest.name !== source.packageName || manifest.version !== source.packageVersion) {
    throw new Hl7BridgeError(
      'PROFILE_PACK_MISMATCH',
      `${dir}/package.json`,
      `El package.json declara ${manifest.name}@${manifest.version} pero el pack esperaba ${source.packageName}@${source.packageVersion}.`,
    );
  }
  if (!manifest.fhirVersions?.includes('4.0.1')) {
    throw new Hl7BridgeError('PROFILE_PACK_MISMATCH', `${dir}/package.json`, `El paquete no declara fhirVersion 4.0.1 (encontrado: ${manifest.fhirVersions?.join(', ') ?? 'ninguno'}).`);
  }
  // .index.json evita parsear cada archivo: lista resourceType+id por entrada.
  const index = readJson<{ files: FhirIndexEntry[] }>(`${dir}/.index.json`, source.packageName);
  return index.files.filter((f) => f.resourceType === 'StructureDefinition').map((f) => f.id);
}

const SD_FILE = /^StructureDefinition-(.+)\.json$/;

/**
 * Modo loose-json: sin manifiesto, se itera directo el directorio. El id se deriva del nombre
 * de archivo (convención del IG Publisher: StructureDefinition-{id}.json), evitando parsear cada JSON.
 */
function loadLooseJson(dir: string): string[] {
  return readdirSync(dir)
    .map((f) => SD_FILE.exec(f)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
}

function readJson<T>(path: string, packName: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    throw new Hl7BridgeError('PROFILE_PACK_LOAD', path, `No se pudo leer el pack "${packName}": ${(e as Error).message}`, { cause: e });
  }
}

const IG_ROOT = new URL('../../fhir_igs/', import.meta.url);

/**
 * Definiciones de los packs nacionales reales. NO se cargan al importar (los IG no se
 * publican con el paquete npm — no están en package.json "files"): se resuelven bajo demanda
 * vía loadProfilePack para trazabilidad/tests. La validación NO depende de estos archivos.
 */
export const PROFILE_PACK_INPUTS: Record<'cl-core' | 'co-core', ProfilePackInput> = {
  'cl-core': {
    id: 'cl-core',
    country: 'CL',
    fhirVersion: '4.0.1',
    source: {
      kind: 'npm-package',
      packageName: 'hl7.fhir.cl.clcore',
      packageVersion: '1.8.5',
      path: fileURLToPath(new URL('fhir_clcore_ig/package/', IG_ROOT)),
    },
  },
  'co-core': {
    id: 'co-core',
    country: 'CO',
    fhirVersion: '4.0.1',
    source: {
      kind: 'loose-json',
      path: fileURLToPath(new URL('fhir_cocore_ig/', IG_ROOT)),
      declaredPackageName: 'hl7.fhir.co.core',
      // v0.1.0: dato confirmado en el sitio web de la IG (co.fhir.guide/core), NO en el artefacto
      // descargado, que no publica package.json. Local dev build — puede cambiar sin aviso.
      declaredPackageVersion: '0.1.0',
      note: 'co.fhir.guide/core no publica package.json; versión confirmada en el sitio web de la IG, no en el artefacto descargado',
    },
  },
};

export type ProfileId = 'us-core' | 'cl-core' | 'co-core';

/**
 * Reglas de validación FHIR por perfil. Curadas a mano desde el differential real de cada IG
 * (cardinalidades min>=1), no auto-derivadas ni inventadas. Independientes de los archivos del
 * IG en disco, para que la validación funcione en el paquete npm publicado sin redistribuir la IG.
 */
export const PROFILE_RULES: Record<ProfileId, Record<string, ProfileRule[]>> = {
  'us-core': FHIR_PROFILE,
  'cl-core': CL_CORE_PROFILE,
  'co-core': CO_CORE_PROFILE,
};

import { Hl7BridgeError } from '../errors/index.js';
import type { Issue, Severity } from './index.js';
import type { ProfileId } from './profilePack.js';

/**
 * Validación contra un HL7 FHIR Validator remoto (validator.fhir.org o una instancia propia).
 * Usa la última versión publicada del IG, así que no depende de reglas mantenidas a mano.
 * El payload sale de la máquina: el CLI solo llama aquí si el usuario lo pide (--validator remote).
 */
export const DEFAULT_VALIDATOR_URL = 'https://validator.fhir.org';

export type ValidatorInfo = { kind: 'inbuilt' } | { kind: 'remote'; url: string; ig: string; profiles: string[] };
type RemoteValidatorInfo = Extract<ValidatorInfo, { kind: 'remote' }>;

// Sin versión: el validador resuelve la última publicada. CO Core no está en el registro de
// paquetes FHIR (validator.fhir.org responde 500 en /igVersions/hl7.fhir.co.core).
const IG_PACKAGES: Partial<Record<ProfileId, string>> = {
  'us-core': 'hl7.fhir.us.core',
  'cl-core': 'hl7.fhir.cl.clcore',
};

// Los mapas US Core no declaran meta.profile y, sin declaración, el validador solo revisa R4 base.
// Los mapas solo producen observaciones y reportes de laboratorio.
const US_CORE_SD = 'http://hl7.org/fhir/us/core/StructureDefinition/';
const US_CORE_PROFILES: Record<string, string> = {
  Patient: 'us-core-patient',
  Encounter: 'us-core-encounter',
  Observation: 'us-core-observation-lab',
  DiagnosticReport: 'us-core-diagnosticreport-lab',
  ServiceRequest: 'us-core-servicerequest',
  Specimen: 'us-core-specimen',
};

const SEVERITY: Record<string, Severity> = { FATAL: 'error', ERROR: 'error', WARNING: 'warning', INFORMATION: 'information' };
const BASE_SD = 'http://hl7.org/fhir/StructureDefinition/';
const TIMEOUT_MS = 60_000;

interface RemoteIssue {
  level?: string;
  location?: string;
  message?: string;
  messageId?: string;
  validationContext?: string;
}

export async function validateFhirRemote(
  payload: fhir4.Bundle | fhir4.FhirResource,
  profile: ProfileId,
  url: string,
): Promise<{ issues: Issue[]; validator: RemoteValidatorInfo }> {
  // El payload suele venir de JSON sin tipar: lo que no es FHIR no debe salir de la máquina.
  if (typeof payload !== 'object' || payload === null || !('resourceType' in payload)) {
    throw new Hl7BridgeError('VALIDATE_INPUT', 'payload', 'kind "fhir" espera un Bundle FHIR.');
  }
  const ig = IG_PACKAGES[profile];
  if (ig === undefined) {
    throw new Hl7BridgeError(
      'REMOTE_PROFILE_UNSUPPORTED',
      '--profile',
      `El validador remoto no puede validar ${profile}: su IG no está publicado en el registro de paquetes FHIR. Usa --validator inbuilt.`,
    );
  }
  const base = url.replace(/\/+$/, '');
  const content = profile === 'us-core' ? withUsCoreClaims(payload) : payload;
  const body = JSON.stringify({
    cliContext: { sv: '4.0.1', igs: [ig], locale: 'es' },
    filesToValidate: [
      { fileName: payload.resourceType === 'Bundle' ? 'bundle.json' : 'resource.json', fileContent: JSON.stringify(content), fileType: 'json' },
    ],
  });

  let status: number;
  let text: string;
  try {
    const res = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const err = e as Error;
    const why = err.name === 'TimeoutError' ? `sin respuesta en ${TIMEOUT_MS / 1000} s` : `${err.name}: ${err.message}`;
    throw new Hl7BridgeError('REMOTE_VALIDATOR_UNAVAILABLE', base, `No se pudo contactar al validador remoto (${why}).`, { cause: e });
  }
  if (status < 200 || status > 299) {
    throw new Hl7BridgeError(
      status >= 500 ? 'REMOTE_VALIDATOR_UNAVAILABLE' : 'REMOTE_VALIDATOR_REJECTED',
      base,
      `El validador remoto respondió HTTP ${status}: ${text.slice(0, 200)}`,
    );
  }
  const remote = remoteIssues(text);
  if (remote === undefined) {
    throw new Hl7BridgeError('REMOTE_VALIDATOR_REJECTED', base, 'El validador remoto respondió con un formato inesperado (se esperaba {outcomes: [{issues}]}).');
  }

  const profiles = [...new Set(remote.map((i) => i.validationContext).filter((c): c is string => !!c && !c.startsWith(BASE_SD)))];
  return {
    issues: remote.map((i) => ({
      severity: SEVERITY[i.level ?? ''] ?? 'error',
      code: i.messageId || 'REMOTE_ISSUE',
      // El validador intercala comentarios como /*Patient/null*/; se quitan para dejar un FHIRPath legible.
      location: (i.location ?? '').replace(/\/\*.*?\*\//g, '') || '-',
      message: i.message ?? '',
    })),
    validator: { kind: 'remote', url: base, ig, profiles },
  };
}

/** Copia del payload con meta.profile de US Core en cada recurso que no declare uno. */
function withUsCoreClaims(payload: fhir4.Bundle | fhir4.FhirResource): fhir4.Bundle | fhir4.FhirResource {
  const copy = structuredClone(payload);
  const resources = copy.resourceType === 'Bundle' ? (copy.entry ?? []).map((e) => e.resource) : [copy];
  for (const resource of resources) {
    const sd = resource && US_CORE_PROFILES[resource.resourceType];
    if (resource && sd && !resource.meta?.profile?.length) resource.meta = { ...resource.meta, profile: [`${US_CORE_SD}${sd}`] };
  }
  return copy;
}

/** Issues de la respuesta, o undefined si no tiene la forma {outcomes: [{issues: []}]}. */
function remoteIssues(text: string): RemoteIssue[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const outcomes = (data as { outcomes?: unknown } | null)?.outcomes;
  if (!Array.isArray(outcomes) || !outcomes.every((o) => Array.isArray((o as { issues?: unknown } | null)?.issues))) return undefined;
  return outcomes.flatMap((o) => (o as { issues: RemoteIssue[] }).issues);
}

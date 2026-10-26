import { z } from 'zod';
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

// Sin meta.profile el validador solo revisa R4 base aunque se haya cargado el IG, así que cada
// recurso sin declaración recibe la del perfil pedido (en una copia). Los mapas US Core solo
// producen observaciones y reportes de laboratorio; los CL declaran CorePacienteCl en Patient.
const US_CORE_SD = 'http://hl7.org/fhir/us/core/StructureDefinition/';
const PROFILE_CLAIMS: Partial<Record<ProfileId, Record<string, string>>> = {
  'us-core': {
    Patient: `${US_CORE_SD}us-core-patient`,
    Encounter: `${US_CORE_SD}us-core-encounter`,
    Observation: `${US_CORE_SD}us-core-observation-lab`,
    DiagnosticReport: `${US_CORE_SD}us-core-diagnosticreport-lab`,
    ServiceRequest: `${US_CORE_SD}us-core-servicerequest`,
    Specimen: `${US_CORE_SD}us-core-specimen`,
  },
  'cl-core': { Patient: 'https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl' },
};

const SEVERITY: Record<string, Severity> = { FATAL: 'error', ERROR: 'error', WARNING: 'warning', INFORMATION: 'information' };
const BASE_SD = 'http://hl7.org/fhir/StructureDefinition/';
const TIMEOUT_MS = 60_000;

// Se envía un solo archivo: sin outcomes, ese archivo no se validó y no puede leerse como "sin issues".
const responseSchema = z.object({
  outcomes: z
    .array(
      z.object({
        issues: z.array(
          z.object({
            level: z.string().nullish(),
            location: z.string().nullish(),
            message: z.string().nullish(),
            messageId: z.string().nullish(),
            validationContext: z.string().nullish(),
          }),
        ),
      }),
    )
    .min(1),
});

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
  const body = JSON.stringify({
    cliContext: { sv: '4.0.1', igs: [ig], locale: 'es' },
    filesToValidate: [
      {
        fileName: payload.resourceType === 'Bundle' ? 'bundle.json' : 'resource.json',
        fileContent: JSON.stringify(withProfileClaims(payload, PROFILE_CLAIMS[profile] ?? {})),
        fileType: 'json',
      },
    ],
  });

  let status: number;
  let text: string;
  try {
    const res = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Una redirección reenviaría el payload a un host que el usuario no eligió.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    const err = error as Error;
    const why = err.name === 'TimeoutError' ? `sin respuesta en ${TIMEOUT_MS / 1000} s` : `${err.name}: ${err.message}`;
    throw new Hl7BridgeError('REMOTE_VALIDATOR_UNAVAILABLE', base, `No se pudo contactar al validador remoto (${why}).`, { cause: error });
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

  const profiles = [...new Set(remote.map((issue) => issue.validationContext).filter((context): context is string => !!context && !context.startsWith(BASE_SD)))];
  return {
    issues: remote.map((issue) => ({
      severity: SEVERITY[issue.level ?? ''] ?? 'error',
      code: issue.messageId || 'REMOTE_ISSUE',
      // El validador intercala comentarios como /*Patient/null*/; se quitan para dejar un FHIRPath legible.
      location: (issue.location ?? '').replace(/\/\*.*?\*\//g, '') || '-',
      message: issue.message ?? '',
    })),
    validator: { kind: 'remote', url: base, ig, profiles },
  };
}

/** Copia del payload con meta.profile en cada recurso que no declare uno y tenga perfil en `claims`. */
function withProfileClaims(payload: fhir4.Bundle | fhir4.FhirResource, claims: Record<string, string>): fhir4.Bundle | fhir4.FhirResource {
  const copy = structuredClone(payload);
  const resources = copy.resourceType === 'Bundle' ? (copy.entry ?? []).map((entry) => entry.resource) : [copy];
  for (const resource of resources) {
    const claim = resource && claims[resource.resourceType];
    if (resource && claim && !resource.meta?.profile?.length) resource.meta = { ...resource.meta, profile: [claim] };
  }
  return copy;
}

/** Issues de la respuesta, o undefined si no es la respuesta del validador. */
function remoteIssues(text: string): z.infer<typeof responseSchema>['outcomes'][number]['issues'] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = responseSchema.safeParse(data);
  return parsed.success ? parsed.data.outcomes.flatMap((outcome) => outcome.issues) : undefined;
}

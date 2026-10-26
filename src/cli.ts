#!/usr/bin/env node
/**
 * CLI del engine: la misma lógica que las tools MCP, por stdin/stdout y en JSON. Es el punto de
 * entrada que la skill hl7-fhir-bridge empaqueta (build.mjs del repo hl7-bridge-skill).
 * No escribe logs: el contenido clínico solo viaja por stdin/stdout.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { errorPayload, Hl7BridgeError } from './errors/index.js';
import { loadMaps, mapV2ToFhir } from './mapper/index.js';
import { parseHl7v2 } from './parser/index.js';
import {
  DEFAULT_VALIDATOR_URL,
  explainError,
  issueSchema,
  parseJsonPayload,
  validateFhirRemote,
  validateMessage,
  type Issue,
  type ValidatorInfo,
} from './validator/index.js';
import type { ProfileId } from './validator/profilePack.js';

// Relativo a este archivo: en el engine apunta a maps/ del repo; en la skill, a hl7-fhir-bridge/maps/.
const MAPS_DIR = new URL('../maps/', import.meta.url);
const PROFILES: readonly string[] = ['us-core', 'cl-core', 'co-core'];

export const USAGE = `Usage: hl7bridge <command> [file|-] [options]   (no file or "-" reads stdin)
  parse    <hl7>                                   HL7 v2 message -> typed AST
  map      <hl7> [--map ID] [--profile P] [--validator V] [--validator-url URL]
                                                   HL7 v2 -> FHIR R4 Bundle + explained validation
  validate <payload> --kind hl7v2|fhir [--profile P] [--validator V] [--validator-url URL]
                                                   structured issues, no conversion
  explain  <issue.json>                            human explanation of one issue
  maps                                             available maps (national maps need --map)
P = us-core (default) | cl-core | co-core
V = inbuilt (default) | remote (FHIR only; URL default ${DEFAULT_VALIDATOR_URL})`;

export interface CliResult {
  exitCode: 0 | 1 | 2;
  out: unknown;
}

const usage = (why: string): CliResult => ({
  exitCode: 2,
  out: { error: { code: 'USAGE', location: 'argv', humanMessage: `${why}\n${USAGE}` } },
});

export async function run(argv: string[], stdin: () => string = () => readFileSync(0, 'utf8')): Promise<CliResult> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: 'string' },
        profile: { type: 'string' },
        kind: { type: 'string' },
        validator: { type: 'string' },
        'validator-url': { type: 'string' },
      },
    });
  } catch (e) {
    return usage((e as Error).message);
  }
  const { values, positionals } = args;
  const [cmd, src] = positionals;
  if (values.profile !== undefined && !PROFILES.includes(values.profile)) return usage(`Unknown --profile "${values.profile}".`);
  const profile = (values.profile ?? 'us-core') as ProfileId;
  const remote = values.validator === 'remote';
  if (values.validator !== undefined && !remote && values.validator !== 'inbuilt') return usage(`Unknown --validator "${values.validator}".`);
  const validatorUrl = values['validator-url'];
  // Sin --validator remote, una URL sería ignorada y el usuario creería haber validado en remoto.
  if (validatorUrl !== undefined && !remote) return usage('--validator-url needs --validator remote.');
  if (validatorUrl !== undefined) {
    const url = URL.canParse(validatorUrl) ? new URL(validatorUrl) : undefined;
    // Credentials would be echoed in validator.url and in error locations; don't repeat the URL either.
    if (url?.username || url?.password) return usage('--validator-url must not contain credentials.');
    // The payload is PHI: cleartext only to this machine, TLS to anything else.
    const loopback = url !== undefined && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(\.\d+){3}$/.test(url.hostname));
    if (!(url?.protocol === 'https:' || (url?.protocol === 'http:' && loopback))) {
      return usage(`--validator-url must be https (plain http only for localhost), got "${validatorUrl}".`);
    }
  }

  // Remoto o inbuilt, nunca ambos: si el remoto falla, el error sale tal cual (sin fallback).
  const validateBundle = async (payload: fhir4.Bundle | fhir4.FhirResource): Promise<{ issues: Issue[]; validator: ValidatorInfo }> =>
    remote
      ? validateFhirRemote(payload, profile, validatorUrl ?? DEFAULT_VALIDATOR_URL)
      : { issues: validateMessage(payload, 'fhir', profile), validator: { kind: 'inbuilt' } };

  const input = (): string => {
    if (src === undefined || src === '-') return stdin();
    try {
      return readFileSync(src, 'utf8');
    } catch (e) {
      throw new Hl7BridgeError('INPUT_READ', src, `No se pudo leer el archivo: ${(e as Error).message}`);
    }
  };

  try {
    switch (cmd) {
      case 'parse':
        return { exitCode: 0, out: { ast: parseHl7v2(input()) } };
      case 'map': {
        // Las degradaciones del mapeo van primero: condicionan cómo leer los issues de perfil.
        const issues: Issue[] = [];
        const bundle = mapV2ToFhir(input(), { mapId: values.map, issues, maps: loadMaps(MAPS_DIR) });
        const checked = await validateBundle(bundle);
        issues.push(...checked.issues);
        return { exitCode: 0, out: { bundle, validation: { issues, explained: issues.map(explainError), validator: checked.validator } } };
      }
      case 'validate': {
        const kind = values.kind;
        if (kind !== 'hl7v2' && kind !== 'fhir') return usage('validate needs --kind hl7v2|fhir.');
        if (kind === 'hl7v2' && remote) return usage('--validator remote only validates FHIR (--kind fhir).');
        const raw = input();
        if (kind === 'hl7v2') return { exitCode: 0, out: { issues: validateMessage(raw, kind, profile), validator: { kind: 'inbuilt' } } };
        return { exitCode: 0, out: await validateBundle(parseJsonPayload(raw) as fhir4.Bundle) };
      }
      case 'explain': {
        const parsed = issueSchema.safeParse(parseJsonPayload(input()));
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
          throw new Hl7BridgeError('INVALID_ISSUE', 'issue', `El issue no tiene la forma {severity, code, location, message}: ${detail}`);
        }
        return { exitCode: 0, out: explainError(parsed.data) };
      }
      case 'maps':
        return { exitCode: 0, out: { maps: loadMaps(MAPS_DIR).map(({ id, messageType, profile }) => ({ id, messageType, profile })) } };
      default:
        return usage(cmd === undefined ? 'Missing command.' : `Unknown command "${cmd}".`);
    }
  } catch (e) {
    return { exitCode: 1, out: { error: errorPayload(e) } };
  }
}

// Solo al ejecutarse como script (también vía symlink de npm bin), no al importarse en tests.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, out } = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = exitCode;
}

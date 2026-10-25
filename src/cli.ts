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
import { explainError, issueSchema, parseJsonPayload, validateFhir, validateMessage, type Issue } from './validator/index.js';
import type { ProfileId } from './validator/profilePack.js';

// Relativo a este archivo: en el engine apunta a maps/ del repo; en la skill, a hl7-fhir-bridge/maps/.
const MAPS_DIR = new URL('../maps/', import.meta.url);
const PROFILES: readonly string[] = ['us-core', 'cl-core', 'co-core'];

export const USAGE = `Usage: hl7bridge <command> [file|-] [options]   (no file or "-" reads stdin)
  parse    <hl7>                                   HL7 v2 message -> typed AST
  map      <hl7> [--map ID] [--profile P]          HL7 v2 -> FHIR R4 Bundle + explained validation
  validate <payload> --kind hl7v2|fhir [--profile P]  structured issues, no conversion
  explain  <issue.json>                            human explanation of one issue
  maps                                             available maps (national maps need --map)
P = us-core (default) | cl-core | co-core`;

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
      options: { map: { type: 'string' }, profile: { type: 'string' }, kind: { type: 'string' } },
    });
  } catch (e) {
    return usage((e as Error).message);
  }
  const { values, positionals } = args;
  const [cmd, src] = positionals;
  if (values.profile !== undefined && !PROFILES.includes(values.profile)) return usage(`Unknown --profile "${values.profile}".`);
  const profile = values.profile as ProfileId | undefined;

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
        issues.push(...validateFhir(bundle, profile));
        return { exitCode: 0, out: { bundle, validation: { issues, explained: issues.map(explainError) } } };
      }
      case 'validate': {
        const kind = values.kind;
        if (kind !== 'hl7v2' && kind !== 'fhir') return usage('validate needs --kind hl7v2|fhir.');
        const raw = input();
        const payload = kind === 'fhir' ? (parseJsonPayload(raw) as fhir4.Bundle) : raw;
        return { exitCode: 0, out: { issues: validateMessage(payload, kind, profile) } };
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

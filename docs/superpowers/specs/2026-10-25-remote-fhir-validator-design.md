# Remote FHIR validator option for the hl7bridge CLI

Status: draft for approval · Date: 2026-10-25 · Repos: `hl7-bridge-mcp` (engine), `hl7-bridge-skill` (skill)

## Intent

Today the engine validates FHIR with curated FHIRPath rules in `src/validator/catalog.ts` and
`profilePack.ts`. Those rules are maintained by hand, so they fall behind every time US Core, CL Core
or CO Core publishes a new version, and the skill keeps validating against stale rules without saying
so. Feedback on the published skill asked for remote validators. The official HL7 FHIR Validator
(`validator.fhir.org`) validates against the published StructureDefinitions of each IG and stays
current on its own.

The goal is to let the user **choose** the validator: the current inbuilt one (offline, fast,
deterministic) or a remote HL7 FHIR Validator. It is one or the other, never both chained.

Scope: the CLI that the skill bundles (`src/cli.ts`) and the skill that ships it. The MCP server
(`src/server/`) is out of scope and gets the same option in a later, separate change.

## Goals

- `map` and `validate --kind fhir` accept `--validator inbuilt|remote`. Default: `inbuilt`.
- `--validator-url <url>` selects the server. Default: `https://validator.fhir.org`.
- Remote validation always uses the **latest published version** of the IG (no version pin).
- Remote issues come back in the engine's existing issue shape (`severity`, `code`, `location`,
  `message`), so `explained` and the skill's report work unchanged.
- The output says which validator ran and which IG/profile versions it used, so a result can be traced.
- The skill tells the agent when to use remote validation and what to warn the user about.

## Non-goals

- Remote validation of HL7 v2 (the remote validator only validates FHIR).
- MCP server support (separate change; prompt already handed to the user).
- Removing or rewriting the inbuilt validator.
- Caching, retries, session reuse across runs, or a configurable timeout.
- Publishing a new npm version or a new skill release.

## Anti-goals (a failure even if it technically works)

- A Bundle reaching a third-party server without the user having chosen it. Inbuilt stays the default
  and the skill only uses remote validation on explicit request.
- Silent fallback to the inbuilt validator when the remote call fails. The user would believe the
  Bundle was checked against the official IG when it was not.
- Remote validation that quietly checks only base FHIR R4 when the user asked for a profile (see
  US Core profile claims below).
- Tests that depend on the network, which would make CI flaky.

## Constraints

- Node ≥ 20 (`engines`), built-in `fetch` and `AbortSignal.timeout`. **No new dependencies.**
- The engine logs nothing, and remote validation must not change that. Message content only travels on
  stdin/stdout and in the request body sent to the chosen validator.
- Engine conventions: typed `Hl7BridgeError(code, location, humanMessage)`, never a bare `Error`;
  user-facing messages in Spanish; code and comments in English or matching the surrounding file.
- Engine CI (`.github/workflows/ci.yml`) is the gate:
  `npm ci && npm run typecheck && npm run lint && npm run test:coverage && npm run build`.

## Remote validator API (verified 2026-10-25 against validator.fhir.org)

- Wrapper 1.0.85, core validator 7.0.3. OpenAPI at `https://validator.fhir.org/openapi.yml`.
- `POST {url}/validate`, `Content-Type: application/json`, no authentication:
  ```json
  { "cliContext": { "sv": "4.0.1", "igs": ["hl7.fhir.us.core"], "locale": "es" },
    "filesToValidate": [ { "fileName": "bundle.json", "fileContent": "<JSON string>", "fileType": "json" } ] }
  ```
  `sessionId` is marked required in the OpenAPI but is optional in practice. An IG without `#version`
  resolves to the latest published version (verified: `hl7.fhir.cl.clcore` → 1.9.4).
- Response 200: `{ outcomes: [ { fileInfo, issues: [...] } ], sessionId, validationTimes }`. Each issue
  carries `level` (`FATAL|ERROR|WARNING|INFORMATION`), `location` (FHIRPath, sometimes with noise such as
  `Bundle.entry[0].resource/*Patient/null*/.name[0]`), `message`, `messageId`, `type`, `line`, `col`,
  `validationContext` (e.g. `http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|9.0.0`).
- 400/500 return `text/plain`.
- Latency: about 15 s for a small resource on a cold session.
- The validator follows each entry's `meta.profile` inside a Bundle once the IG is loaded (verified with
  CL Core `CorePacienteCl`).
- IG availability:

  | `--profile` | IG package | On validator.fhir.org |
  |---|---|---|
  | `us-core` | `hl7.fhir.us.core` | yes (latest 9.0.0) |
  | `cl-core` | `hl7.fhir.cl.clcore` | yes (latest 1.9.4) |
  | `co-core` | `hl7.fhir.co.core` | **no**, `/igVersions/hl7.fhir.co.core` → 500 "List size is 0" |

## Design

### CLI surface

```
map      <hl7>     [--map ID] [--profile P] [--validator inbuilt|remote] [--validator-url URL]
validate <payload> --kind hl7v2|fhir [--profile P] [--validator inbuilt|remote] [--validator-url URL]
```

- Unknown `--validator` value → `USAGE` (exit 2).
- `--validator remote` with `--kind hl7v2` → `USAGE`: remote validation only covers FHIR.
- `--validator-url` without `--validator remote` → `USAGE` (so a typo never looks like a remote run).
- `--validator-url` must parse as an `http:` or `https:` URL → otherwise `USAGE`. A trailing slash is
  stripped before appending `/validate`.

### Request

- One file per run: the Bundle (or single resource) serialized as JSON, `fileName: "bundle.json"`
  (`"resource.json"` for a single resource), `fileType: "json"`.
- `cliContext`: `sv: "4.0.1"`, `igs: [<package for --profile>]` with no version, `locale: "es"`.
- `--profile co-core` with `--validator remote` → rejection `REMOTE_PROFILE_UNSUPPORTED` (exit 1), with a
  Spanish `humanMessage` explaining that CO Core isn't published in the FHIR package registry and
  suggesting `--validator inbuilt`. Checked before any network call.
- **US Core profile claims.** US Core maps don't set `meta.profile` (CL and CO maps do). Without claims
  the remote validator checks only base R4. Before sending, the engine adds the US Core profile to a
  **copy** of the payload for each resource that has no `meta.profile`. The user's Bundle in the output
  is not modified. Mapping:

  | resourceType | profile |
  |---|---|
  | Patient | `http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient` |
  | Encounter | `…/us-core-encounter` |
  | Observation | `…/us-core-observation-lab` (the maps only produce lab observations) |
  | DiagnosticReport | `…/us-core-diagnosticreport-lab` |
  | ServiceRequest | `…/us-core-servicerequest` |
  | Specimen | `…/us-core-specimen` |

  Other resource types are sent without a claim. For `cl-core`, an unclaimed Patient gets
  `https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl`, the same claim the CL maps
  make. Without it, `validate --kind fhir --profile cl-core` on an unclaimed Bundle, or a base map run
  with `--profile cl-core`, would only be checked against base R4. (Amended after the final review;
  the first draft relied on the maps' claims alone.)
- Timeout: 60 s via `AbortSignal.timeout(60_000)`. Constant, not configurable.
- Redirects are not followed (`redirect: 'error'`), so the payload only goes to the URL the user chose.
- A 200 response must have at least one outcome. An empty `outcomes` means the file wasn't validated,
  so it's `REMOTE_VALIDATOR_REJECTED`, not a clean pass.

### Response → issues

- `FATAL`/`ERROR` → `error`, `WARNING` → `warning`, `INFORMATION` → `information`.
- `code`: the issue's `messageId`, or `REMOTE_ISSUE` when it is missing. `explain` falls back to its
  generic hint for these codes. That's acceptable, because the remote message is already human-readable
  and in Spanish.
- `location`: the remote `location` with `/*…*/` comments removed, so it reads as plain FHIRPath (e.g.
  `Bundle.entry[0].resource.name[0]`).
- `message`: the remote `message` as is.
- `fileInfo.fileContent` (an echo of the payload) is never copied to the output.
- In `map`, the mapping issues the mapper produces (`UNMAPPED_SEGMENT`, `MAP_FALLBACK_APPLIED`) are kept
  first, as today. The remote issues replace everything `validateFhir` would have added after them
  (profile and coding issues).
- Exit code is 0 whenever the remote call succeeds, whatever the issues say. Same as today: issues
  describe quality, they don't reject.

### Output provenance

Both commands add a `validator` object. It goes next to `issues` (`validate`) and inside `validation`
(`map`):

```jsonc
{ "kind": "inbuilt" }
{ "kind": "remote", "url": "https://validator.fhir.org", "ig": "hl7.fhir.cl.clcore",
  "profiles": ["https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl|1.9.4"] }
```

`profiles` holds the distinct `validationContext` values of the returned issues that belong to the
requested IG (base `http://hl7.org/fhir/StructureDefinition/*` contexts excluded). It may be empty when
there are no issues. This is additive: the existing fields keep their shape.

### Failure handling (exit 1, never a fallback)

| Code | When | `location` |
|---|---|---|
| `REMOTE_PROFILE_UNSUPPORTED` | `--profile co-core` with remote | `--profile` |
| `REMOTE_VALIDATOR_UNAVAILABLE` | network error, DNS, timeout, or HTTP 5xx | the validator URL |
| `REMOTE_VALIDATOR_REJECTED` | HTTP 4xx, or a 200 whose body isn't the expected shape | the validator URL |

The `humanMessage` includes the HTTP status or the error class, plus the first 200 characters of a
text/plain error body when there is one. It never includes the payload.

### Code layout

- `src/validator/remote.ts`: `validateFhirRemote(payload, profile, url): Promise<{ issues, validator }>`.
  Holds the profile→IG table, the US Core claim injection, the HTTP call and the translation. It is
  exported so the MCP change can reuse it without duplicating anything.
- `src/cli.ts`: `run()` becomes `async` and the entry point awaits it. New options are parsed with the
  existing `parseArgs`.
- Tests in `src/validator/remote.test.ts` and `src/cli.test.ts` use `vi.stubGlobal('fetch', …)`. They
  cover: request body (IG without version, `locale`, US Core claims injected on a copy only), level
  mapping, location cleanup, provenance, `co-core` rejected before any fetch, timeout/5xx → UNAVAILABLE,
  4xx and bad shape → REJECTED, and every new `USAGE` path. No test touches the network.

## Prerequisite: restore `src/cli.ts` in the engine

The skill's bundle was built from `src/cli.ts`, but that file isn't in any branch of `hl7-bridge-mcp`,
local or on GitHub. `THIRD_PARTY_NOTICES.txt` says the bundle came from `hl7-bridge-mcp@0.3.0 (git
511e266)`. That commit doesn't exist in the repo and npm only has 0.1.0 and 0.2.0. The bundle is
unminified, so the source can be recovered from it (`hl7-fhir-bridge/scripts/hl7bridge.mjs`, sections
marked `// ../hl7-bridge-mcp/src/...`). Compared with the engine's `main`, the lost version differs in:

1. `src/cli.ts` (whole file, bundle line 69973 onward).
2. `errorPayload(e)` in `src/errors/index.ts`.
3. `issueSchema` and `parseJsonPayload` exported from `src/validator/index.ts`, where `main` keeps an
   `issueSchema` and the JSON parsing inside `src/server/server.ts`. Restore them in the validator module
   and make `server.ts` import them. No behavior change for the MCP server.
4. `loadMaps` in the bundle resolves files with `fileURLToPath(new URL(name, base))`. `main` uses
   `.pathname`, which breaks on paths with spaces, and the skill's smoke test copies to such a path on
   purpose. Restore the bundle's version.
5. CL Core rules: the bundle has CL Core **1.8.5**, while engine `main` has **1.9.4** with realigned
   rules. Rebuilding the skill from `main` upgrades its inbuilt CL Core validation to 1.9.4. That's
   intended, but it is a behavior change the skill PR must call out.

The comparison above was done section by section after stripping identifier renames. Re-check it by
rebuilding the bundle from the restored engine and diffing the `// ../hl7-bridge-mcp/src/...` sections
against the shipped bundle. The only expected differences are item 5 and the bundler's renames.

This restore lands as its own commit (`chore(cli): restore cli entry point from skill bundle`), with
TypeScript types and a basic `src/cli.test.ts` covering the existing commands, before any remote code.
`package.json` version is left at 0.2.0 (release numbering is out of scope).

## Skill changes (`hl7-bridge-skill`, branch `feat/fhir-validator-api`)

- Order: the engine PR merges first, and the skill is then rebuilt from the engine's `main`. Building
  from the feature branch would record a commit in `THIRD_PARTY_NOTICES.txt` that disappears after a
  squash merge, which is how the current bundle ended up pointing at a commit that doesn't exist. The
  skill PR stays a draft until then.
- Rebuild with `node build.mjs ../hl7-bridge-mcp` (engine checked out at `main`). This regenerates
  `scripts/hl7bridge.mjs`, `maps/` and `THIRD_PARTY_NOTICES.txt`, and runs the built-in smoke test.
- `SKILL.md`:
  - Inbuilt is the default. Use `--validator remote` only when the user asks for it, or asks for
    "official"/"up-to-date" IG validation and accepts it.
  - Before the first remote run in a conversation, tell the user that the Bundle is sent to the chosen
    server (a public third-party service by default). If the message looks like real patient data, ask
    before sending.
  - Remote isn't available for CO Core or HL7 v2. Expect about 15 s or more per call. Results can change
    over time because the latest IG version is used. Always report `validator.profiles` so the user can
    tell which IG version was applied.
  - Update the "two gaps the validator doesn't flag" note: it applies to the inbuilt validator.
- `references/cli-reference.md`: new options, the `validator` output field, the three new rejection
  codes, the new `USAGE` cases, and the fact that remote issue codes are HL7 validator `messageId`s.
- `evals/evals.json`: add cases for (a) the user asking for remote validation of a synthetic ORU (the
  agent uses `--validator remote`, warns that the data leaves the machine, and reports the profile
  versions) and (b) remote with CO Core (the agent reports it isn't supported and offers inbuilt).
  Running the eval iterations is optional and out of scope.

## Verification

- Engine: the CI command above passes locally and on the PR.
- Skill: `node build.mjs ../hl7-bridge-mcp` succeeds, including its smoke test.
- Manual end-to-end, **synthetic fixtures only** (`test/fixtures/*.hl7`):
  `map test/fixtures/oru_r01.hl7 --validator remote` and the CL fixture with `--profile cl-core
  --validator remote`, against validator.fhir.org. Record the output in the PR.

## Left to the builder

- Exact Spanish wording of the new `humanMessage`s and USAGE text.
- Internal helper names and how the US Core profile table is declared.
- How `cli.test.ts` drives `run()` (direct call with a stubbed stdin is enough).

## Skill CI (`hl7-bridge-skill/.github/workflows/merge-checks.yaml`)

The user moved the template workflows to the repo root and asked for `merge-checks.yaml` to be adapted.
The skill repo has no lint and no unit tests. Its real check is `build.mjs`, which bundles the engine,
runs a smoke test from a copy outside both repos, and zips the skill. Adapted `merge-checks`:

- One job: check out this repo, check out `GlennRTC/hl7-bridge-mcp` at `main` into a subfolder, set up
  Node 22 (matching the engine's CI), run `npm ci` in the engine, then `node build.mjs <engine path>`.
- Drop the template scaffolding (INIT.md guard, `{{…}}` tokens, `.nvmrc`).
- The other template workflows are left as the user placed them. `template-checks.yaml` references
  scripts that don't exist in this repo and will fail. That's flagged to the user, not changed here.

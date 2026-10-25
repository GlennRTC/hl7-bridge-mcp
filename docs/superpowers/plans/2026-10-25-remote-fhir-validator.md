# Remote FHIR Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the hl7bridge CLI (and the skill that ships it) validate FHIR with either the inbuilt rules or a remote HL7 FHIR Validator.

**Architecture:** Restore the lost `src/cli.ts` in the engine. Add `src/validator/remote.ts`, a single async function that builds the validator.fhir.org request, calls it with built-in `fetch`, and translates the response into the engine's `Issue[]`. Wire it into the CLI behind `--validator remote`. Then rebuild the skill from engine `main`, update its docs and evals, and adapt the skill repo's CI.

**Tech Stack:** TypeScript (NodeNext, strict), Node ≥ 20 built-in `fetch`/`AbortSignal.timeout`, zod, fhirpath, Vitest, esbuild (via `build.mjs`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-25-remote-fhir-validator-design.md` (engine repo). Read it before any task.

## Global Constraints

- Repos and branches: engine `/home/glenn/Denv/hl7-bridge-mcp` on `feat/remote-fhir-validator`; skill `/home/glenn/Denv/hl7-bridge-skill` on `feat/fhir-validator-api`.
- Conventional Commits, imperative, ≤ 72 chars, one logical change per commit. No push, PR merge, or force-push without the user's explicit approval in the session.
- No new dependencies. Use built-in `fetch`, `AbortSignal.timeout(60_000)`, `URL.canParse`.
- Default validator URL: `https://validator.fhir.org`. Request: `POST {url}/validate`, `cliContext = { sv: "4.0.1", igs: [<package>], locale: "es" }`, IG package **without** `#version`.
- Profile → IG: `us-core` → `hl7.fhir.us.core`, `cl-core` → `hl7.fhir.cl.clcore`, `co-core` → rejection `REMOTE_PROFILE_UNSUPPORTED`.
- Errors are `Hl7BridgeError(code, location, humanMessage)` with Spanish `humanMessage`. Never include payload content in an error, and never log.
- No test touches the network. Stub `fetch` with `vi.stubGlobal('fetch', …)` and restore it with `vi.unstubAllGlobals()` in `afterEach`.
- Test and fixture data stays synthetic (`test/fixtures/*`).
- Engine verification (same as `.github/workflows/ci.yml`): `npm run typecheck && npm run lint && npm run test:coverage && npm run build`, all green.
- Engine source style: comments in Spanish like the surrounding files, test names in Spanish, `.js` import suffixes.

## Review Focus

1. A self-hosted validator URL with a path prefix (`https://host/validator/`) must call `https://host/validator/validate`, not drop the prefix. Test in Task 2.
2. A 200 response that isn't JSON (proxy or captive-portal HTML) must become `REMOTE_VALIDATOR_REJECTED`, not `INTERNAL`. Test in Task 2.
3. A valid Bundle (no issues) must return `issues: []` and `profiles: []` and must not throw. Test in Task 2.
4. A single resource (not a Bundle) sent with `validate --kind fhir` gets `fileName: "resource.json"` and its own US Core claim. Bundle entries with no `resource` don't crash claim injection. Test in Task 2.
5. Map directories whose path contains spaces (the skill's smoke test copies to `/tmp/hl7 skill …`) must load. Test in Task 1.

---

### Task 1: Restore the CLI entry point and the helpers it needs

The shipped skill bundle (`/home/glenn/Denv/hl7-bridge-skill/hl7-fhir-bridge/scripts/hl7bridge.mjs`) is unminified. Recover the source from its `// ../hl7-bridge-mcp/src/...` sections: `cli.ts` starts at line 69973, `errorPayload` at line 25250, and `issueSchema`/`parseJsonPayload` at lines 69885–69897.

**Files:**
- Create: `src/cli.ts`, `src/cli.test.ts`
- Modify: `src/errors/index.ts` (add `errorPayload`), `src/validator/index.ts` (add `issueSchema`, `parseJsonPayload`), `src/server/server.ts` (import those three, delete its local `issueSchema`, `parseFhirPayload` and the inline payload in `fail`), `src/mapper/index.ts:54-60` (`loadMaps` path fix), `src/mapper/mapper.test.ts`

**Interfaces:**
- Produces: `errorPayload(e: unknown): { code: string; location: string; humanMessage: string }` (errors/index.ts)
- Produces: `issueSchema` (zod object: severity enum, code, location, message, same descriptions as today's server.ts) and `parseJsonPayload(payload: string): unknown`. The latter throws `INVALID_JSON` at `payload` with `El payload no es JSON válido: …`, as in the bundle. Both live in validator/index.ts.
- Produces: `run(argv: string[], stdin?: () => string): Promise<{ exitCode: 0 | 1 | 2; out: unknown }>` and `USAGE: string` (cli.ts). `run` is **async** from the start. Task 3 needs it async, and making it async now avoids rewriting these tests later. The `if (process.argv[1] …)` entry block awaits it.

- [ ] **Step 1: Write the failing tests** in `src/cli.test.ts` (fixtures via `fileURLToPath(new URL('../test/fixtures/<name>', import.meta.url))`):
  - `parse devuelve el AST`: `run(['parse', adt])` → `exitCode 0`, `out.ast.segments[0].name === 'MSH'`.
  - `map ORU produce Bundle y validación explicada`: `run(['map', oru])` → `exitCode 0`, `out.bundle.entry.length === 3`, `out.validation.explained.length === out.validation.issues.length`.
  - `validate --kind fhir acepta un Bundle`: `run(['validate', <path of test/fixtures/oru_r01.bundle.json>, '--kind', 'fhir'])` → `exitCode 0`, `Array.isArray(out.issues)`.
  - `stdin con "-"`: `run(['validate', '-', '--kind', 'hl7v2'], () => <adt text>)` → `exitCode 0`, `out.issues` equals `[]`.
  - `usage`: no command, unknown command, `validate` without `--kind`, `--profile xx` → each `exitCode 2`, `out.error.code === 'USAGE'`.
  - `errores tipados`: missing file → `exitCode 1`, `INPUT_READ`. `explain` with `{"foo":1}` on stdin → `exitCode 1`, `INVALID_ISSUE`.
  - `maps lista ids`: `out.maps.some(m => m.id === 'oru_r01_to_fhir_r4')`.
- [ ] **Step 2: Add the failing map-path test** in `src/mapper/mapper.test.ts`: `loadMaps lee directorios con espacios`. Copy the repo `maps/` into `mkdtempSync(join(tmpdir(), 'hl7 maps '))`. `loadMaps(pathToFileURL(dir + '/'))` must have the same length as `loadMaps()`.
- [ ] **Step 3: Run** `npx vitest run src/cli.test.ts src/mapper/mapper.test.ts`. Expected: FAIL (cli module missing; `ENOENT …%20…` for the space path).
- [ ] **Step 4: Implement.** Port the bundle's `cli.ts` to TypeScript (keep the `#!/usr/bin/env node` hashbang, `MAPS_DIR = new URL('../maps/', import.meta.url)`, `PROFILES`, the `USAGE` text and the logic as is, apart from `async`). Add the three helpers and switch `server.ts` to them. In `loadMaps`, replace `new URL(e.name, base).pathname` with `fileURLToPath(new URL(e.name, base))`.
- [ ] **Step 5: Run** the engine verification command. Expected: all green, and existing server tests unchanged and passing. The MCP `INVALID_JSON` humanMessage text changes from "El payload FHIR…" to "El payload…". Note it in the PR.
- [ ] **Step 6: Fidelity check.** Run `S=<scratchpad>; cp -r /home/glenn/Denv/hl7-bridge-skill $S/skill-copy && node $S/skill-copy/build.mjs /home/glenn/Denv/hl7-bridge-mcp`. Expected: `OK …` (smoke test passes). Then compare the engine sections: `diff <(grep -v '^//' /home/glenn/Denv/hl7-bridge-skill/hl7-fhir-bridge/scripts/hl7bridge.mjs) <(grep -v '^//' $S/skill-copy/hl7-fhir-bridge/scripts/hl7bridge.mjs)`. Expected: the only differences are the CL Core `packageVersion` (1.8.5→1.9.4), `CL_CORE_PROFILE` rules, the `async`/`await` in `run`, and the notices commit. Anything else means the restore missed something; fix it before committing. Never run `build.mjs` in the real skill repo during this task.
- [ ] **Step 7: Commit** (two commits):
  ```bash
  git add src/mapper/index.ts src/mapper/mapper.test.ts
  git commit -m "fix(mapper): load map files from paths with spaces"
  git add src/cli.ts src/cli.test.ts src/errors/index.ts src/validator/index.ts src/server/server.ts
  git commit -m "chore(cli): restore cli entry point from skill bundle"
  ```

### Task 2: Remote validator client

**Files:**
- Create: `src/validator/remote.ts`, `src/validator/remote.test.ts`
- Modify: `src/validator/index.ts` (re-export the public names below)

**Interfaces:**
- Consumes: `Issue`, `ProfileId`, `Hl7BridgeError`.
- Produces:
  ```ts
  export const DEFAULT_VALIDATOR_URL = 'https://validator.fhir.org';
  export type ValidatorInfo =
    | { kind: 'inbuilt' }
    | { kind: 'remote'; url: string; ig: string; profiles: string[] };
  export async function validateFhirRemote(
    payload: fhir4.Bundle | fhir4.FhirResource,
    profile: ProfileId,
    url: string,
  ): Promise<{ issues: Issue[]; validator: Extract<ValidatorInfo, { kind: 'remote' }> }>;
  ```
  `validator.url` is the URL as given, minus a trailing slash. `ig` is the package name.

- [ ] **Step 1: Write the failing tests** in `src/validator/remote.test.ts`. Use the helper `respond(status, body, contentType)` to return a `Response`, and the fixtures `oru_r01.bundle.json` and `cl/oru_r01_cl.bundle.json`.
  - `petición: IG sin versión, sv 4.0.1, locale es` (us-core, url `https://validator.example.org/`): fetch called once with `'https://validator.example.org/validate'`, `method: 'POST'`, header `Content-Type: application/json`, `init.signal instanceof AbortSignal`. Body `cliContext` toEqual `{ sv: '4.0.1', igs: ['hl7.fhir.us.core'], locale: 'es' }`. `filesToValidate[0]` has `fileName: 'bundle.json'`, `fileType: 'json'`.
  - `us-core: inyecta perfiles en una copia`: the parsed `fileContent` entries have `meta.profile` set to `[…/us-core-patient]`, `[…/us-core-observation-lab]` and `[…/us-core-diagnosticreport-lab]` (prefix `http://hl7.org/fhir/us/core/StructureDefinition/`). The input object `toEqual` a `structuredClone` taken before the call. A resource that already has `meta.profile: ['x']` keeps `['x']`. A Bundle entry with no `resource` doesn't throw.
  - `recurso suelto`: Patient payload → `fileName: 'resource.json'`, `meta.profile` = `[…/us-core-patient]`.
  - `cl-core: envía el payload sin tocar`: `fileContent === JSON.stringify(clBundle)`, `igs: ['hl7.fhir.cl.clcore']`.
  - `prefijo de ruta`: url `https://host/validator/` → fetch URL `https://host/validator/validate`.
  - `traduce issues`: response issues with levels `FATAL`, `ERROR`, `WARNING`, `INFORMATION`. One has `location: 'Bundle.entry[0].resource/*Patient/null*/.name[0]'`, one has no `messageId`. Expected severities `error`, `error`, `warning`, `information`; location `Bundle.entry[0].resource.name[0]`; code = `messageId`, else `REMOTE_ISSUE`; `message` as is.
  - `procedencia`: validationContexts `…CorePacienteCl|1.9.4` (twice) and `http://hl7.org/fhir/StructureDefinition/Patient|4.0.1` → `validator` toEqual `{ kind: 'remote', url: 'https://validator.fhir.org', ig: 'hl7.fhir.cl.clcore', profiles: ['https://hl7chile.cl/fhir/ig/clcore/StructureDefinition/CorePacienteCl|1.9.4'] }`.
  - `bundle válido`: `{ outcomes: [{ issues: [] }] }` → `issues: []`, `profiles: []`.
  - `co-core rechazado antes de llamar`: rejects with code `REMOTE_PROFILE_UNSUPPORTED`, location `--profile`; fetch not called.
  - `red caída`: fetch rejects `new TypeError('fetch failed')` → `REMOTE_VALIDATOR_UNAVAILABLE`, location = url. Timeout: fetch rejects `new DOMException('t', 'TimeoutError')` → same code.
  - `5xx`: 503 text body of 500 `'a'`s → `REMOTE_VALIDATOR_UNAVAILABLE`. humanMessage contains `503` and `'a'.repeat(200)` but not `'a'.repeat(201)`.
  - `4xx`: 400 `'No files for validation provided in request.'` → `REMOTE_VALIDATOR_REJECTED`, humanMessage contains `400`.
  - `200 sin forma esperada`: body `{}` → `REJECTED`. Body `'<html>'` with `text/html` → `REJECTED`.
  - `nunca filtra el payload`: in every error case above, humanMessage doesn't contain `"resourceType"`.
- [ ] **Step 2: Run** `npx vitest run src/validator/remote.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `validateFhirRemote`** in `src/validator/remote.ts`. Keep two constant tables: profile→IG package, and resourceType→US Core profile (the six rows in the spec). Inject claims into a `structuredClone`. Location cleanup is `location.replace(/\/\*.*?\*\//g, '')`. A response counts as valid when `outcomes` is an array and each element's `issues` is an array. The JSON parse failure of a 200 maps to `REJECTED`. Truncate the error body with `.slice(0, 200)`.
- [ ] **Step 4: Run** the engine verification command. Expected: all green.
- [ ] **Step 5: Commit**
  ```bash
  git add src/validator/remote.ts src/validator/remote.test.ts src/validator/index.ts
  git commit -m "feat(validator): add remote HL7 FHIR Validator client"
  ```

### Task 3: Wire `--validator` and `--validator-url` into the CLI

**Files:**
- Modify: `src/cli.ts`, `src/cli.test.ts`

**Interfaces:**
- Consumes: `validateFhirRemote`, `DEFAULT_VALIDATOR_URL`, `ValidatorInfo` (Task 2); `run` (Task 1).
- Produces: output fields `map → validation.validator: ValidatorInfo` and `validate → validator: ValidatorInfo` (also `{ kind: 'inbuilt' }` for `--kind hl7v2`). Updated `USAGE` lines:
  ```
  map      <hl7> [--map ID] [--profile P] [--validator V] [--validator-url URL]
  validate <payload> --kind hl7v2|fhir [--profile P] [--validator V] [--validator-url URL]
  V = inbuilt (default) | remote (FHIR only; URL default https://validator.fhir.org)
  ```

- [ ] **Step 1: Write the failing tests** (append to `src/cli.test.ts`; stub `fetch` as in Task 2):
  - `por defecto inbuilt y sin red`: `run(['map', oru])` → `validation.validator` toEqual `{ kind: 'inbuilt' }`, fetch not called.
  - `map --validator remote`: stub returns one issue `{ level: 'ERROR', location: 'Patient', message: 'm', messageId: 'X', validationContext: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|9.0.0' }`. Expect `exitCode 0`; `validation.validator` toEqual `{ kind: 'remote', url: 'https://validator.fhir.org', ig: 'hl7.fhir.us.core', profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|9.0.0'] }`; issues include code `X`, location `Patient`; no issue has code `PROFILE_REQUIRED` or `CODING_NO_SYSTEM`; `explained.length === issues.length`.
  - `validate --kind fhir --validator remote --validator-url https://v.example/`: fetch URL `https://v.example/validate`; `out.validator.url === 'https://v.example'`.
  - `usage`: `--validator foo`; `--validator-url https://x` without `--validator remote`; `--validator remote --validator-url ftp://x`; `--validator remote --validator-url nope`; `validate --kind hl7v2 --validator remote` → each `exitCode 2`, `USAGE`.
  - `fallo remoto sin fallback`: fetch rejects → `exitCode 1`, `out.error.code === 'REMOTE_VALIDATOR_UNAVAILABLE'`, and `out` has no `bundle` key.
  - `co-core remoto`: `run(['map', <path of test/fixtures/co/adt_a01_co.hl7>, '--map', 'adt_a01_to_cocore', '--profile', 'co-core', '--validator', 'remote'])` → `exitCode 1`, `REMOTE_PROFILE_UNSUPPORTED`, fetch not called.
- [ ] **Step 2: Run** `npx vitest run src/cli.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Add the `validator` and `validator-url` string options to `parseArgs`. Validate options right after the existing `--profile` check: value ∈ `inbuilt|remote`; url only with remote; `URL.canParse` and protocol `http:`/`https:`. The `hl7v2` + remote check goes in the `validate` case. Mapping issues come first, followed by either `validateFhir` or the remote issues. Never fall back.
- [ ] **Step 4: Run** the engine verification command. Expected: all green.
- [ ] **Step 5: Manual end-to-end** (network, synthetic fixtures only):
  `npx tsx src/cli.ts map test/fixtures/oru_r01.hl7 --validator remote`, then
  `npx tsx src/cli.ts map test/fixtures/cl/oru_r01_cl.hl7 --map oru_r01_to_clcore --profile cl-core --validator remote`.
  Expected: exit 0; `validation.validator.kind === 'remote'`; `profiles` lists US Core `…|9.x` and CL Core `…|1.9.x` respectively; locations without `/*…*/`. Save both outputs for the PR description.
- [ ] **Step 6: Commit**
  ```bash
  git add src/cli.ts src/cli.test.ts
  git commit -m "feat(cli): add --validator remote option for FHIR validation"
  ```
- [ ] **Step 7: Stop for approval.** Show the branch, the commit count and the diff summary, then ask to push `feat/remote-fhir-validator` and open the engine PR. The PR body must mention the restored files, the CL Core 1.8.5→1.9.4 note for the skill, and the MCP `INVALID_JSON` text change. Don't merge without approval.

### Task 4: Adapt the skill repo's merge checks

Independent of Tasks 1–3. Works in `/home/glenn/Denv/hl7-bridge-skill` on `feat/fhir-validator-api`.

**Files:**
- Modify: `.github/workflows/merge-checks.yaml` (replace the template)
- Commit as is (untracked, moved there by the user): `.github/pull_request_template.md`, `.github/workflows/claude-review.yaml`, `.github/workflows/branch-governance-audit.yaml`, `.github/workflows/template-checks.yaml`. Ask the user whether they want them committed in this change before adding them. If not, commit only `merge-checks.yaml`.

- [ ] **Step 1: Write `merge-checks.yaml`.** Name `Merge Checks`. Keep `on` (pull_request, push to `main`), `concurrency` and `permissions: contents: read`. One job, `build`, named `Build and smoke test`, on `ubuntu-latest`, with these steps: `actions/checkout@v4`; `actions/checkout@v4` with `repository: GlennRTC/hl7-bridge-mcp`, `ref: main`, `path: hl7-bridge-mcp`; `actions/setup-node@v4` with `node-version: "22"`, `cache: npm`, `cache-dependency-path: hl7-bridge-mcp/package-lock.json`; `npm ci` with `working-directory: hl7-bridge-mcp`; `node build.mjs hl7-bridge-mcp`. Drop the INIT.md guard, the tokens and `.nvmrc`. The header comment says, in one paragraph, what the job proves.
- [ ] **Step 2: Verify the YAML parses:** `node -e "require('/home/glenn/Denv/hl7-bridge-mcp/node_modules/yaml').parse(require('fs').readFileSync('.github/workflows/merge-checks.yaml','utf8'))" && echo ok`. Expected: `ok`.
- [ ] **Step 3: Verify the job's command locally**, without touching the real `dist/`: `cp -r . <scratchpad>/skill-ci && node <scratchpad>/skill-ci/build.mjs /home/glenn/Denv/hl7-bridge-mcp`. Expected: `OK …`.
- [ ] **Step 4: Commit**
  ```bash
  git add .github/workflows/merge-checks.yaml
  git commit -m "ci: build and smoke-test the skill on every PR"
  ```
  Report to the user that `template-checks.yaml` will fail on every run (it calls `.claude/skills/...` scripts that don't exist here). The CI run itself is only observable after a push, which needs approval.

### Task 5: Rebuild the skill and document remote validation

**Blocked until** the engine PR from Task 3 is merged into `main` (user approval). Works in `/home/glenn/Denv/hl7-bridge-skill` on `feat/fhir-validator-api`.

**Files:**
- Regenerated by `build.mjs`: `hl7-fhir-bridge/scripts/hl7bridge.mjs`, `hl7-fhir-bridge/maps/**`, `hl7-fhir-bridge/THIRD_PARTY_NOTICES.txt`
- Modify: `hl7-fhir-bridge/SKILL.md`, `hl7-fhir-bridge/references/cli-reference.md`, `evals/evals.json`

**Interfaces:**
- Consumes: the CLI surface and output fields from Task 3; the rejection codes from Task 2.

- [ ] **Step 1: Rebuild from engine main:** `git -C ../hl7-bridge-mcp switch main && git -C ../hl7-bridge-mcp pull --ff-only && node build.mjs ../hl7-bridge-mcp`. Expected: `OK …`. `THIRD_PARTY_NOTICES.txt` first line names a commit that `git -C ../hl7-bridge-mcp cat-file -t <sha>` reports as `commit` on `main`.
- [ ] **Step 2: Bundle check:** `node hl7-fhir-bridge/scripts/hl7bridge.mjs validate ../hl7-bridge-mcp/test/fixtures/oru_r01.bundle.json --kind fhir --validator remote --profile co-core; echo $?`. Expected: `REMOTE_PROFILE_UNSUPPORTED`, `1`.
- [ ] **Step 3: Update `SKILL.md`:**
  - Section 2 table: add the row "Validate against the official/latest IG (US Core, CL Core) → `map`/`validate --kind fhir` with `--validator remote` — only when the user asks".
  - Add a short "Remote validation" subsection:
    - Before the first remote run, tell the user the Bundle goes to the validator server (public third party by default; `--validator-url` for their own). Ask first if the message looks like real patient data.
    - Not available for CO Core or HL7 v2.
    - Expect ~15 s or more.
    - Results can change over time because the latest IG is used.
    - Always report `validator.profiles`.
    - On `REMOTE_VALIDATOR_UNAVAILABLE`, report it and offer the inbuilt validator. Never present inbuilt results as remote.
  - Section 6: the "Validation covers structure…" bullet and "Two gaps the validator doesn't flag" apply to the inbuilt validator. Point to `--validator remote` instead of recommending the HL7 validator as a manual second pass.
- [ ] **Step 4: Update `references/cli-reference.md`:**
  - Command table: add the new options.
  - Output shapes: add `validator` (both kinds).
  - Rejection table: add `REMOTE_PROFILE_UNSUPPORTED`, `REMOTE_VALIDATOR_UNAVAILABLE`, `REMOTE_VALIDATOR_REJECTED`, plus the new `USAGE` cases.
  - Issue codes: remote issues use the HL7 validator `messageId` (or `REMOTE_ISSUE`).
  - Change the intro's "The engine logs nothing…" sentence to add that remote mode sends the payload to the chosen validator.
- [ ] **Step 5: Add evals 5 and 6** to `evals/evals.json`, in the same shape as eval 1 (synthetic messages only):
  - 5: the user pastes a synthetic ORU and asks to validate it "against the official, latest US Core". Expectations: runs with `--validator remote`; warns the Bundle is sent to validator.fhir.org before or with the run; reports the US Core profile version from `validator.profiles`; doesn't present inbuilt results as remote.
  - 6: the user asks for remote validation with Colombia's CO Core. Expectations: reports that remote isn't available for CO Core; offers the inbuilt `co-core` validation; doesn't call it with another profile silently.
- [ ] **Step 6: Verify:** `node build.mjs ../hl7-bridge-mcp` passes again (the docs live inside the zipped folder), and `python3 -c "import json; json.load(open('evals/evals.json'))"`. Expected: `OK …` and no output.
- [ ] **Step 7: Commit** (two commits):
  ```bash
  git add hl7-fhir-bridge/scripts hl7-fhir-bridge/maps hl7-fhir-bridge/THIRD_PARTY_NOTICES.txt
  git commit -m "build: rebuild skill from engine with remote validator"
  git add hl7-fhir-bridge/SKILL.md hl7-fhir-bridge/references/cli-reference.md evals/evals.json
  git commit -m "docs(skill): document opt-in remote FHIR validation"
  ```
- [ ] **Step 8: Stop for approval** to push and open the skill PR. The PR body notes the CL Core 1.8.5→1.9.4 inbuilt upgrade.

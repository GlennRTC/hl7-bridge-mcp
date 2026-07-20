# HL7-Bridge MCP

**Translate, validate and explain clinical messages between HL7 v2.x and FHIR R4 — as a tool for your AI agent.**

[![CI](https://github.com/GlennRTC/hl7-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/GlennRTC/hl7-bridge-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-black)](https://modelcontextprotocol.io)

```text
IN   ORU^R01  ·  HL7 v2, lab result
     OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F

OUT  FHIR R4 Bundle  →  Patient · Observation · DiagnosticReport
     ✓ conforms to US Core
     ⚠ if PID-8 (sex) were empty:
       "US Core Patient requires gender"   →  Patient.gender
```

> ⚠️ **Not a medical device.** Not validated for clinical decisions. Mappings
> require human validation before any use with real data. See [SECURITY.md](SECURITY.md).

## What it is

A hospital's systems speak two "languages". **HL7 v2** is the old, telegraphic one that labs
and admissions use to announce "patient Juan Pérez was admitted" or "glucose 95 mg/dL". **FHIR**
is the modern JSON one used by apps, portals and newer systems.

This is a **translator between the two that also reviews the translation** and explains errors in
human language. It's not just another FHIR CRUD: it's the *validated translation layer* an agent
needs so it doesn't have to talk directly to a raw FHIR server. It does three things:

- **Translates** HL7 v2 → FHIR (and the reverse, in future phases).
- **Validates** against profiles (US Core): that a lab's category isn't missing, that the patient's name is present…
- **Explains** *what* failed and *where* — "the required PV1 segment for an admission is missing" — without opening the spec.

The moat isn't the MCP protocol, it's the **mapping knowledge**: instead of rules hidden in the
code, it uses **declarative maps** ([`maps/`](maps/), readable and versionable YAML) of the form
"message PID-5 → Patient's name". Auditable, correctable translation without touching code.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `parse_hl7v2` | `{ message }` | `{ ast }` — segments → fields → components, separators read from MSH-1/2 |
| `map_v2_to_fhir` | `{ message, mapId?, fhirVersion? }` | `{ bundle, validation: { issues, explained } }` |
| `validate_message` | `{ payload, kind: "hl7v2"\|"fhir", profile? }` | `{ issues }` with `location` (segment-field or FHIRPath) |
| `explain_error` | `{ issue }` | `{ humanMessage, location, hint }` |

Maps in v0.1: `ADT^A01`, `ORU^R01`, `ORM^O01` → FHIR R4 (see [`maps/`](maps/)). Non-obvious
mappings are marked `TODO(mapeo)` and are **not guessed**.

> Note: the server's human-readable messages (`message`, `humanMessage`, `hint`) are currently
> emitted in Spanish. The examples below are translated for readability.

### Call → result (one per tool)

Each tool is invoked via `tools/call` with these `arguments`. Output is abbreviated; the full curl and
more cases (malformed, edge) are in [USAGE.md](USAGE.md).

<details>
<summary><code>parse_hl7v2</code> — typed AST, separators read from MSH-1/2</summary>

```jsonc
// arguments
{ "message": "MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M" }
// → result
{ "ast": {
  "encoding": { "field":"|","component":"^","repetition":"~","escape":"\\","subcomponent":"&" },
  "segments": [ /* MSH, PID → fields → components → subcomponents */ ]
} }
// message not starting with MSH → isError: { "error": { "code":"INVALID_HEADER", "location":"MSH" } }
```
</details>

<details>
<summary><code>map_v2_to_fhir</code> — FHIR R4 Bundle + explained validation</summary>

```jsonc
// arguments
{ "message": "MSH|...|ORU^R01|...\rPID|...\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F" }
// → result
{ "bundle": { "resourceType":"Bundle", "entry":[ /* Patient · Observation · DiagnosticReport */ ] },
  "validation": { "issues": [], "explained": [] } }        // clean if it conforms to US Core
```
</details>

<details>
<summary><code>validate_message</code> — structural issues (v2) or profile issues (FHIR)</summary>

```jsonc
// arguments: an ADT^A01 with no PV1 and no name
{ "kind": "hl7v2", "payload": "MSH|...|ADT^A01|...\rEVN|A01|20260101\rPID|1||123456^^^H^MR" }
// → result
{ "issues": [
  { "severity":"error", "code":"MISSING_SEGMENT", "location":"PV1",  "message":"Falta el segmento requerido PV1 para ADT^A01." },
  { "severity":"error", "code":"MISSING_FIELD",   "location":"PID-5","message":"Falta el campo requerido PID-5 para ADT^A01." }
] }
```
</details>

<details>
<summary><code>explain_error</code> — enriches an issue with human language and HL7 tables</summary>

```jsonc
// arguments
{ "issue": { "severity":"information", "code":"CODED", "location":"OBX-11", "message":"OBX-11 tiene el valor 'F'." } }
// → result
{ "humanMessage": "OBX-11 tiene el valor 'F'. El valor 'F' significa \"Final\" (tabla HL7 0085).",
  "location": "OBX-11 (Observation result status)",
  "hint": "Revisa el mensaje de origen contra la especificación del perfil." }
```
</details>

## Try it

Start in HTTP and call `map_v2_to_fhir` with a lab result:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
PORT=3999 npm run start:http &

curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F"}}}' | extract
```

It returns a `Bundle` with **Patient · Observation · DiagnosticReport** and clean validation
(`"issues": []`). `Observation.category` = `laboratory` (which US Core requires) is populated as a
**deliberate constant documented in the map** — HL7 v2 has no field that carries it and an
`ORU^R01` is always laboratory —, not a guessed value.

**The value is in what it warns about.** With the same message but **without PID-8 (sex)**, `gender`
does come from a message field, so its absence is real debt that validation reports with an exact
`location` and a human explanation:

```json
"issues": [
  { "severity":"error", "code":"PROFILE_REQUIRED", "location":"Patient.gender",
    "message":"US Core Patient requiere gender." }
],
"explained": [
  { "humanMessage":"US Core Patient requiere gender.", "location":"Patient.gender",
    "hint":"El perfil FHIR exige este elemento (must-support). Ajusta el mapa o el mensaje de origen para poblarlo." }
]
```

The difference with `category` is one of origin: `gender` has a v2 field (PID-8) that was left empty;
`category` is a constant with no field. The full test set for all 4 tools (valid, malformed, edge
cases) is in [USAGE.md](USAGE.md).

## Usage

```bash
# Development
npm ci && npm test              # + npm run typecheck / lint / test:coverage

# stdio (local MCP clients, e.g. Claude Desktop)
npm run build && npm start

# HTTP (Streamable HTTP for hosting): POST /mcp, health at /healthz, port $PORT
npm run build && npm run start:http
```

### Local install in Claude Code (`claude mcp add`)

After `npm ci && npm run build`, register it as a stdio server (use an absolute path to `dist`):

```bash
claude mcp add hl7-bridge -- node "$(pwd)/dist/server/index.js"
```

HTTP variant (Streamable HTTP), against an already-running server on `$PORT`:

```bash
npm run start:http &                                   # local, or use your Render URL
claude mcp add hl7-bridge --transport http http://localhost:3999/mcp
```

Verify with `claude mcp list` and, inside Claude Code, with `/mcp`. To remove it:
`claude mcp remove hl7-bridge`.

**Deploy on Render (free tier):** the repo includes [`render.yaml`](render.yaml) as a Blueprint.
The service hibernates after ~15 min (first request ~30-60 s) and the endpoint **has no
authentication** — use it only with synthetic data.

## Design principles

- **PHI-safe by default** — the repo never contains real PHI; logs redact PID/NK1/GT1.
- **Narrow tools** — each tool has typed input/output, not a "do whatever you want".
- **Determinism and explainability** — every error carries structure + *what* and *where* in human language.
- **Fail loudly** — a malformed message yields a structured error, never a silent partial result.
- **Not a medical device** — no clinical decisions without human validation.

## Stack and structure

**TypeScript** (Node ≥ 20) strict, official MCP SDK (`@modelcontextprotocol/sdk`), `fhirpath.js`
+ `@types/fhir`, Vitest. Typed errors (`Hl7BridgeError` with `code`, `location`, `humanMessage`).

```
/src/{server,parser,mapper,validator,errors}   # MCP · HL7 v2 · declarative mapping · FHIR profiles · errors
/maps                                          # declarative YAML maps (ADT, ORU, ORM…)
/test/fixtures                                 # synthetic messages + expected outputs
```

Detail in [`context/ARCHITECTURE.md`](context/ARCHITECTURE.md) (components, I/O contracts,
map format) and [`context/PRD.md`](context/PRD.md).

## License

Apache-2.0 at the core (parser, mapper, validator, MCP tools). See [LICENSE](LICENSE).

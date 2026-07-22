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

## Try it (Claude Code)

This is an MCP server, so the natural way to use it is from an MCP client. In **Claude Code** you
register it once with `claude mcp add` and then just ask in plain language — Claude picks the tool
and fills the arguments for you. No HTTP, no ports, no curl.

**1. Register it as a stdio server.** `tsx` runs the TypeScript source directly — no build step, nothing to go stale:

```bash
npm ci
claude mcp add hl7-bridge -- npx tsx "$(pwd)/src/server/index.ts"
```

Prefer a compiled binary? `npm run build` then register `node "$(pwd)/dist/server/index.js"` instead — but rebuild after every source change.

**2. Verify** with `claude mcp list`, and inside Claude Code with `/mcp` (you should see the four
`hl7-bridge` tools). To remove it later: `claude mcp remove hl7-bridge`.

**3. Ask in natural language.** Paste a message and let Claude call `map_v2_to_fhir`:

> Map this HL7 v2 lab result to FHIR and tell me if it conforms to US Core:
> `MSH|^~\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5` `PID|1||123456^^^H^MR||DOE^JOHN||19800101|M`
> `OBR|1||1|1554-5^GLUCOSE^LN` `OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F`

You get a `Bundle` with **Patient · Observation · DiagnosticReport** and clean validation
(`"issues": []`). `Observation.category` = `laboratory` (which US Core requires) is populated as a
**deliberate constant documented in the map** — HL7 v2 has no field that carries it and an
`ORU^R01` is always laboratory —, not a guessed value.

**The value is in what it warns about.** Now **drop the trailing `M` (PID-8, sex)** from that PID
segment — `...||19800101|M` → `...||19800101|`. Because `gender` *does* come from a message field,
its absence is real debt, and validation reports it with an exact `location` and a human explanation:

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

> Not using Claude Code? To drive the server over **HTTP** from another system (or raw `curl`), see
> the HTTP transport, protocol and per-tool calls in **[USAGE.md](USAGE.md)**.

## Why use it vs. letting the agent translate directly

An LLM can approximate HL7 v2 → FHIR on its own. The value here isn't the conversion — it's that the
conversion is **repeatable, auditable, and refuses to guess**.

| Concern | With this MCP | LLM translating directly |
|---------|---------------|--------------------------|
| **Determinism** | Same input → identical output every run (declarative YAML maps) | Non-deterministic; same message can map differently across runs/models |
| **Won't invent data** | Refuses to guess — unknown coding system → `CODING_NO_SYSTEM` warning, no `system` fabricated; unclear mapping → `TODO(mapeo)` | Hallucinates plausible values (a wrong `system` URI, an invented `gender`) |
| **Parsing** | Reads separators from MSH-1/2; handles repetitions, subcomponents, escapes, `\r`/`\n`/`\r\n` | Usually assumes `\|^~\&` and mis-parses vendor quirks silently |
| **Validation** | Checks US Core requirements, returns exact `location` + human reason | "Looks conformant" — nothing actually validated it |
| **Failure mode** | Fails loudly with a structured error (`MAP_INVALID`, `INVALID_HEADER`) | Fails silently — a partial/wrong Bundle that looks fine |
| **Auditability** | Mapping rule lives in versioned YAML you can diff and correct | Rule lives in a prompt/weights; you can't inspect *why* it mapped that way |

The `gender` case above is the thesis: it flags **real** debt (empty PID-8) with an exact location,
and does **not** flag the deliberate `category` constant. An LLM alone would likely invent a gender
or stay silent.

**Where it doesn't add much:** coverage is narrow today (R4 only; ADT^A01, ORU^R01, ORM^O01, OUL^R22
partial — outside those you get a clean `MAP_NOT_FOUND`); validation is *minimal* US Core, not the
full IG; and it's still not a clinical safety net — output requires human validation. For a one-off,
throwaway translation where repeatability and correctness don't matter, the plain LLM is faster.

**Bottom line:** use it when the output feeds a real system and a wrong-but-plausible Bundle is worse
than a loud failure. For casual exploration, it may be overhead you don't need.

## Usage

```bash
npm ci && npm test              # + npm run typecheck / lint / test:coverage
npm run build && npm start      # stdio server for local MCP clients (Claude Code, Claude Desktop)
```

Full setup, testing and deployment steps are in **[USAGE.md](USAGE.md)**: the **HTTP transport**
(POST /mcp, for hosting or driving the server from another system), the JSON-RPC protocol, a curl
call per tool, the complete test set, and Render deployment.

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

## References

Mapping and validation decisions are grounded in these authoritative sources, not guessed:

- [HL7 v2.5.1 Chapter 7 — Observation Reporting](https://www.hl7.eu/HL7v2x/v251/std251/ch07.html) — message structures (ORU, OUL) and segment optionality.
- [HL7 Version 2 to FHIR Implementation Guide](https://build.fhir.org/ig/HL7/v2-to-fhir/) — segment/datatype ConceptMaps, e.g. [SPM → Specimen](https://www.hl7.org/fhir/uv/v2mappings/2024Jan/ConceptMap-segment-spm-to-specimen.html).
- [HL7/v2-to-fhir repository](https://github.com/HL7/v2-to-fhir) — source `.fsh`/CSV mappings (order-control, patient-class, report-status tables used by transforms).
- [US Core Implementation Guide](https://www.hl7.org/fhir/us/core/) — Patient/Observation profile invariants.
- [FHIR R4 specification](https://hl7.org/fhir/R4/) — target resource model.

## License

Apache-2.0 at the core (parser, mapper, validator, MCP tools). See [LICENSE](LICENSE).

# HL7-Bridge MCP — Usage and testing guide

Instructions to start the server, invoke its 4 tools, and a set of test messages with the
expected result. All examples use **synthetic** data.

> ⚠️ Not a medical device. Not validated for clinical decisions.

> Note: the server's human-readable messages (`message`, `humanMessage`, `hint`) are currently
> emitted in Spanish. The example outputs below preserve them verbatim so they match what the
> running server returns.

## 1. Startup

```bash
npm ci
npm run build
```

**stdio** (local MCP clients, e.g. Claude Desktop):

```bash
npm start
```

Config for an MCP client over stdio:

```json
{
  "mcpServers": {
    "hl7-bridge": { "command": "node", "args": ["/path/to/repo/dist/server/index.js"] }
  }
}
```

Or register it in Claude Code with `claude mcp add hl7-bridge -- npx tsx "$(pwd)/src/server/index.ts"`
(`tsx` runs the source directly, no build to keep in sync; `npm run dev` / `npm run dev:http` do the same locally).

**HTTP** (Streamable HTTP; this is also what runs on Render):

```bash
PORT=3999 npm run start:http     # POST /mcp  ·  health at GET /healthz
```

To point Claude Code at an already-running HTTP server (local or your Render URL):

```bash
claude mcp add hl7-bridge --transport http http://localhost:3999/mcp
```

**Deploy on Render (free tier):** the repo includes [`render.yaml`](render.yaml) as a Blueprint.
The service hibernates after ~15 min (first request ~30-60 s) and the endpoint **has no
authentication** — use it only with synthetic data.

## 2. Protocol (HTTP)

The transport is JSON-RPC 2.0 over `POST /mcp`. The `accept` header must include
`application/json` **and** `text/event-stream`; the response arrives as an SSE event
(`data: {…}`). Standard MCP methods: `initialize`, `tools/list`, `tools/call`.

List the tools:

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Returns: `parse_hl7v2`, `map_v2_to_fhir`, `validate_message`, `explain_error`.

Each tool's result comes in `result.content[0].text` as serialized JSON. To extract it in the
examples below:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
```

## 3. The 4 tools

### `parse_hl7v2` — `{ message }` → `{ ast }`
Typed AST with separators read from MSH-1/MSH-2 (it does not assume `|^~\&`).

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"parse_hl7v2","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102080000||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M"}}}' | extract
```

Result (trimmed): `ast.encoding` = `{ field:"|", component:"^", repetition:"~", escape:"\\", subcomponent:"&" }`
and `ast.segments` = MSH, PID with their fields → components → subcomponents.

A malformed message returns `isError:true` with a typed error, e.g. a message that does not
start with MSH → `{ "error": { "code":"INVALID_HEADER", "location":"MSH", "humanMessage":"…" } }`.

### `map_v2_to_fhir` — `{ message, mapId?, fhirVersion? }` → `{ bundle, validation }`
Maps to a FHIR R4 Bundle and **validates** the result against minimal US Core, explaining each issue.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102080000||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1|845439|1045813|1554-5^GLUCOSE^LN|||20260102073000\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F|||20260102074500"}}}' | extract
```

Expected result — a `Bundle` with three resources:
- `Patient` (identifier 123456, name DOE JOHN, gender male, birthDate 1980-01-01).
- `Observation` (status final, `category` laboratory, code 1554-5/GLUCOSE with `system`
  `http://loinc.org`, valueQuantity 95 mg/dL, effectiveDateTime 2026-01-02T07:45:00, subject → Patient).
- `DiagnosticReport` (one per OBR): `category` LAB (system `v2-0074`, distinct from Observation's),
  code 1554-5/GLUCOSE with `system` LOINC (OBR-4.3 = `LN`), `result[]` → the group's Observation,
  subject → Patient. `status` comes from OBR-25 (table 0123) if present; in this message OBR-25 is
  empty, so it is omitted (not guessed).

Validation comes out **clean**: `"validation": { "issues": [], "explained": [] }`. `category=laboratory`
on the Observation is a deliberate constant (HL7 v2 does not carry it; an ORU is always laboratory) and
the LOINC `system` is derived from OBX-3.3 = `LN` (table 0396).

**Mapping debt — `CODING_NO_SYSTEM`.** When a coded value (OBX type CE/CWE) carries an
**unregistered** coding system (e.g. `99LOCAL`), the `system` is not guessed: the
`valueCodeableConcept.coding` comes out with `code`+`display` but no `system`, and validation
warns about it (non-blocking):

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1||1|5778-6^COLOR^LN\rOBX|1|CE|5778-6^COLOR OF URINE^LN||Y^YELLOW^99LOCAL||||||F"}}}' | extract
```

```json
"validation": {
  "issues": [
    { "severity":"warning", "code":"CODING_NO_SYSTEM", "location":"Observation.valueCodeableConcept.coding[0]",
      "message":"Coding con code \"Y\" pero sin system: el código es ambiguo entre sistemas de codificación." }
  ],
  "explained": [
    { "humanMessage":"Coding con code \"Y\" pero sin system: el código es ambiguo entre sistemas de codificación.",
      "location":"Observation.valueCodeableConcept.coding[0]",
      "hint":"Añade el system URI del código (ej. http://loinc.org). En HL7 v2 suele venir en el 3.er componente (tabla 0396); si es local, registra su URI en el mapa." }
  ]
}
```

If that same OBX used `LN` instead of `99LOCAL`, the `system` would come out `http://loinc.org` and
there would be no warning. A `Coding` with no `code` is a `CODING_EMPTY` error (not just a warning).

`fhirVersion:"R6"` returns `isError` (`UNSUPPORTED_VERSION`): in v0.1 there is only R4.

### `validate_message` — `{ payload, kind, profile? }` → `{ issues }`
`kind:"hl7v2"` validates required segments/fields by message type. `kind:"fhir"` receives a JSON
Bundle (as a string in `payload`) and validates against minimal US Core.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_message","arguments":{"kind":"hl7v2","payload":"MSH|^~\\&|HIS|H|EKG|H|20260101||ADT^A01|MSG1|P|2.5\rEVN|A01|20260101\rPID|1||123456^^^H^MR"}}}' | extract
```

Expected result (ADT^A01 with no PV1 and no name):

```json
{ "issues": [
  { "severity":"error", "code":"MISSING_SEGMENT", "location":"PV1", "message":"Falta el segmento requerido PV1 para ADT^A01." },
  { "severity":"error", "code":"MISSING_FIELD",   "location":"PID-5", "message":"Falta el campo requerido PID-5 para ADT^A01." }
] }
```

### `explain_error` — `{ issue }` → `{ humanMessage, location, hint }`
Enriches an issue: readable field name, meaning of HL7 tables, and a hint.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"explain_error","arguments":{"issue":{"severity":"information","code":"CODED","location":"OBX-11","message":"OBX-11 tiene el valor '"'"'F'"'"'."}}}}' | extract
```

Expected result:

```json
{
  "humanMessage": "OBX-11 tiene el valor 'F'. El valor 'F' significa \"Final\" (tabla HL7 0085).",
  "location": "OBX-11 (Estado del resultado de la observación)",
  "hint": "Revisa el mensaje de origen contra la especificación del perfil."
}
```

## 4. Test set

Synthetic messages and what each should produce. The reference `.hl7` files are in
[`test/fixtures/`](test/fixtures/).

| # | Message | Tool | Expected result |
|---|---------|------|-----------------|
| 1 | `adt_a01.hl7` (valid) | `validate_message` (hl7v2) | `issues: []` |
| 2 | `oru_r01.hl7` (valid) | `validate_message` (hl7v2) | `issues: []` |
| 3 | `orm_o01.hl7` (valid) | `validate_message` (hl7v2) | `issues: []` |
| 4 | `invalid_adt_missing_name.hl7` | `validate_message` (hl7v2) | `MISSING_SEGMENT@PV1`, `MISSING_FIELD@PID-5` |
| 5 | `invalid_oru_missing_obr_code.hl7` | `validate_message` (hl7v2) | `MISSING_SEGMENT@OBR`, `MISSING_FIELD@OBX-3` |
| 6 | `oru_r01.hl7` | `map_v2_to_fhir` | Bundle Patient+Observation+DiagnosticReport (category laboratory/LAB, code with LOINC system, report `status` final from OBR-25, `result[]`→Observation); `issues: []` |
| 7 | `orm_o01.hl7` | `map_v2_to_fhir` | Bundle Patient+ServiceRequest (`status` active from ORC-1=NW via table 0119, intent order, code 1554-5) |
| 8 | Message with no MSH | `parse_hl7v2` | `isError` with `INVALID_HEADER@MSH` |
| 9 | Type `SIU^S12` (no map) | `map_v2_to_fhir` | `isError` with `MAP_NOT_FOUND@MSH-9` |
| 10 | Non-standard separators `:-+?*` | `parse_hl7v2` | `ast.encoding.field=":"`, rest per MSH-2 |
| 11 | OBX `CE` with `Y^YELLOW^99LOCAL` | `map_v2_to_fhir` | `valueCodeableConcept.coding` with no `system`; warning `CODING_NO_SYSTEM` |
| 12 | `adt_a01.hl7` (PID-3 with MR + SS, PV1-2=`I`) | `map_v2_to_fhir` | Patient with **two** identifiers (`123456`/GENERAL_HOSPITAL and `999-99-9999`/USA); Encounter.class `IMP` (system `v3-ActCode`) |
| 13 | OBX `CWE` with alternate coding (`…^LN^371244009^…^SCT`) | `map_v2_to_fhir` | `valueCodeableConcept.coding[0]` LOINC + `coding[1]` SNOMED (CWE.4/5/6) |

Edge cases covered by the fixtures: field repetitions (`~`, two identifiers in PID-3),
subcomponents (`&`), escape sequences (`\T\` → `&`), and line endings `\r`, `\n`, `\r\n`.

### End-to-end smoke test (HTTP)

Start the server (`PORT=3999 npm run start:http`) in another terminal and run:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
post() { curl -s -X POST localhost:3999/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1" | extract; }

# ORU with a CE value from a local system → CODING_NO_SYSTEM warning
post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||42||DOE^JOHN||19800101|M\rOBR|1||1|5778-6^COLOR^LN\rOBX|1|CE|5778-6^COLOR^LN||Y^YELLOW^99LOCAL||||||F"}}}' | grep -q 'CODING_NO_SYSTEM' && echo 'PASS: map+validate' || echo 'FAIL'

# Invalid ADT → two issues
post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_message","arguments":{"kind":"hl7v2","payload":"MSH|^~\\&|HIS|H|EKG|H|20260101||ADT^A01|1|P|2.5\rEVN|A01|20260101\rPID|1||42"}}}' | grep -q 'MISSING_SEGMENT' && echo 'PASS: validate v2' || echo 'FAIL'
```

### Automated suite

The real behavioral coverage lives in the Vitest suite (47 tests):

```bash
npm test               # all
npm run test:coverage  # with a ≥70% gate on parser and mapper
npx vitest run src/mapper/mapper.test.ts   # a single file
```

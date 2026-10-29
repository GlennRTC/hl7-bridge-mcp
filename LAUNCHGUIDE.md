# HL7-Bridge MCP

**Turn HL7 v2 messages into FHIR R4, check them against a profile, and get told exactly what's wrong and where.**

Hospital systems still talk HL7 v2 (labs, admissions, orders). Everything new talks FHIR. This MCP sits in the middle so your agent doesn't have to guess the translation.

> ⚠️ Not a medical device. Not validated for clinical decisions. Synthetic data only. See [SECURITY.md](SECURITY.md).

## What it does

- **Parses** HL7 v2 into a typed AST. Separators are read from MSH-1/2, not assumed.
- **Maps** ADT^A01, ORU^R01, ORM^O01 and OUL^R22 (partial) to a FHIR R4 Bundle, using YAML maps you can read and diff.
- **Validates** HL7 v2 structure or FHIR resources against US Core, CL Core (Chile) or CO Core (Colombia).
- **Explains** every issue with an exact location (`PID-8`, `Patient.gender`) and a plain-language reason.

Same input, same output, every run. If a mapping isn't clear, it says so (`TODO(mapeo)`) instead of making something up.

## Tools

| Tool | Give it | Get back |
|------|---------|----------|
| `parse_hl7v2` | `message` | `ast` |
| `map_v2_to_fhir` | `message`, optional `mapId`, `fhirVersion`, `profile` | `bundle` + `validation` |
| `validate_message` | `payload`, `kind` (`hl7v2` or `fhir`), optional `profile` | `issues` with `location` |
| `explain_error` | one `issue` | `humanMessage`, `location`, `hint` |

`profile` is `us-core` (default), `cl-core` or `co-core`.

## Install

Needs Node 20+.

```bash
git clone https://github.com/GlennRTC/hl7-bridge-mcp.git
cd hl7-bridge-mcp
npm ci && npm run build
```

Claude Code:

```bash
claude mcp add hl7-bridge -- node "$(pwd)/dist/server/index.js"
```

Any other stdio client:

```json
{
  "mcpServers": {
    "hl7-bridge": { "command": "node", "args": ["/path/to/hl7-bridge-mcp/dist/server/index.js"] }
  }
}
```

HTTP instead of stdio: `npm run start:http`, then `POST /mcp` (health check at `GET /healthz`). It ships with a Render blueprint.

## Try it

Ask your agent:

> Map this HL7 v2 lab result to FHIR and tell me if it conforms to US Core:
> `MSH|^~\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5`
> `PID|1||123456^^^H^MR||DOE^JOHN||19800101|M`
> `OBR|1||1|1554-5^GLUCOSE^LN`
> `OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F`

You get a Bundle with Patient, Observation and DiagnosticReport, and no issues.

Now delete the trailing `M` (PID-8). Validation flags `Patient.gender` as required, with the location and a hint. That's the point: it catches real gaps and doesn't invent a value to cover them.

## Why not just let the LLM translate?

It can, roughly. This is for when roughly isn't enough.

- **Deterministic.** No drift between runs or models.
- **Won't invent data.** Unknown coding system gives a `CODING_NO_SYSTEM` warning, not a made-up URI.
- **Fails loudly.** Malformed input returns a structured error, not a plausible-looking Bundle.
- **Auditable.** The rule lives in a YAML map, not in a prompt.

## Limits (read these)

- FHIR R4 only. Four message types, and OUL^R22 is partial. Anything else returns `MAP_NOT_FOUND`.
- Validation is structure and must-support presence. It does not check full value sets or slicing.
- CL Core maps Patient only. CO Core is a v0.1.0 dev build and can change. AR Core isn't implemented.
- The HTTP transport has **no authentication**. Don't point real patient data at it.
- Human-readable messages (`message`, `humanMessage`, `hint`) are in Spanish for now.
- Output needs human review before it touches anything real.

## Also in the box

A CLI that runs the same engine over stdin/stdout (`parse`, `map`, `validate`, `explain`, `maps`). It can also send FHIR validation to an HL7 FHIR Validator with `--validator remote`. Docs in [USAGE.md](USAGE.md).

## Privacy

No real PHI in the repo. Logs redact PID, NK1 and GT1 segments, and message bodies only get logged with `DEBUG_HL7` on (still redacted).

## Links

- Source: https://github.com/GlennRTC/hl7-bridge-mcp
- Full usage and test set: [USAGE.md](USAGE.md)
- Issues: https://github.com/GlennRTC/hl7-bridge-mcp/issues
- Security reports: glenn.r.tomassi@gmail.com
- License: Apache-2.0
- Author: Glenn Tomassi

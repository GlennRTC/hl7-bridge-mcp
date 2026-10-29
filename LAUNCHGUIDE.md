# HL7-Bridge MCP

## Tagline
Translate HL7 v2 to FHIR R4, validate it, and explain every error in plain language.

## Description
Hospital systems still talk HL7 v2 (labs, admissions, orders). Everything new talks FHIR. HL7-Bridge sits in the middle so your agent doesn't have to guess the translation.

It parses HL7 v2, maps it to a FHIR R4 Bundle with declarative YAML maps you can read and diff, validates the result against US Core, CL Core (Chile) or CO Core (Colombia), and explains each issue with an exact location (`PID-8`, `Patient.gender`) and a plain reason. Same input, same output, every run. When a mapping isn't clear it says so instead of inventing a value.

Built for integration engineers and developers working on healthcare interfaces who want a repeatable, auditable translation layer instead of an LLM approximating one.

**Know the limits:** FHIR R4 only. Covers ADT^A01, ORU^R01, ORM^O01 and OUL^R22 (partial). Validation checks structure and must-support presence, not full value sets or slicing. CL Core maps Patient only, and CO Core is a v0.1.0 dev build. Human-readable messages are in Spanish for now. The HTTP transport has no authentication, so use synthetic data only. Not a medical device, and output needs human review.

## Setup Requirements
- `PORT` (optional): HTTP port when running `npm run start:http`. Defaults to `3000`. Not used over stdio.
- `DEBUG_HL7` (optional): set to log message bodies to stderr for debugging. Bodies are always redacted (PID, NK1, GT1). Off by default.

No API keys or accounts needed. Requires Node 20+.

## Category
Developer Tools

## Use Cases
Healthcare Integration, HL7 to FHIR Migration, Interface Testing, Message Validation, Interface Debugging, Mapping Review, Interoperability Prototyping

## Features
- Parse HL7 v2 into a typed AST, with separators read from MSH-1/2 instead of assumed
- Map ADT^A01, ORU^R01, ORM^O01 and OUL^R22 (partial) to a FHIR R4 Bundle
- Validate HL7 v2 structure or FHIR resources against US Core, CL Core or CO Core
- Explain every issue with its exact segment-field or FHIRPath location and a hint
- Deterministic output: same message, same Bundle, every run
- Refuses to guess: unclear mappings are marked `TODO(mapeo)`, unknown coding systems raise `CODING_NO_SYSTEM`
- Fails loudly with structured errors (`INVALID_HEADER`, `MAP_NOT_FOUND`) instead of a plausible-looking partial Bundle
- Mapping rules live in versioned YAML, so they can be audited and corrected without touching code
- Logs redact PID, NK1 and GT1 segments by default
- Runs over stdio or Streamable HTTP, plus a CLI that uses the same engine
- Optional remote validation through an HL7 FHIR Validator (CLI, `--validator remote`)

## Getting Started
- "Map this HL7 v2 lab result to FHIR and tell me if it conforms to US Core: MSH|^~\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5 PID|1||123456^^^H^MR||DOE^JOHN||19800101|M OBR|1||1|1554-5^GLUCOSE^LN OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F"
- "Now remove PID-8 (sex) from that message and validate it again. What breaks, and where?"
- "Is this ADT^A01 structurally valid? Tell me what's missing."
- "Explain this validation issue in plain language."
- Tool: parse_hl7v2 — Parse an HL7 v2 message into segments, fields and components.
- Tool: map_v2_to_fhir — Convert an HL7 v2 message to a FHIR R4 Bundle with explained validation. Takes optional `mapId`, `fhirVersion` and `profile`.
- Tool: validate_message — Validate HL7 v2 (`kind: "hl7v2"`) or FHIR (`kind: "fhir"`) and get issues with locations. `profile` is `us-core` (default), `cl-core` or `co-core`.
- Tool: explain_error — Turn one issue into a human message, location and hint.

## Tags
hl7, hl7v2, fhir, fhir-r4, healthcare, interoperability, us-core, cl-core, co-core, lab-results, adt, oru, validation, mapping, mcp

## Documentation URL
https://github.com/GlennRTC/hl7-bridge-mcp#readme

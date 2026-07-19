# HL7-Bridge MCP

**Traduce, valida y explica mensajes clínicos entre HL7 v2.x y FHIR R4 — como una tool para tu agente de IA.**

[![CI](https://github.com/GlennRTC/hl7-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/GlennRTC/hl7-bridge-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-black)](https://modelcontextprotocol.io)

```text
IN   ORU^R01  ·  HL7 v2, resultado de laboratorio
     OBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F

OUT  FHIR R4 Bundle  →  Patient · Observation · DiagnosticReport
     ✓ cumple US Core
     ⚠ si PID-8 (sexo) viniera vacío:
       "US Core Patient requiere gender"   →  Patient.gender
```

> ⚠️ **No es un dispositivo médico.** No está validado para decisiones clínicas. Los mapeos
> requieren validación humana antes de cualquier uso con datos reales. Ver [SECURITY.md](SECURITY.md).

## Qué es

Los sistemas de un hospital hablan dos "idiomas". **HL7 v2** es el viejo y telegráfico con el
que labs y admisión anuncian "ingresó el paciente Juan Pérez" o "glucosa 95 mg/dL". **FHIR** es
el moderno en JSON que usan apps, portales y sistemas nuevos.

Este es un **traductor entre ambos que además revisa la traducción** y explica los errores en
lenguaje humano. No es un CRUD FHIR más: es la *capa de traducción validada* que un agente
necesita para no hablar directamente con un servidor FHIR crudo. Hace tres cosas:

- **Traduce** HL7 v2 → FHIR (y a la inversa, en fases futuras).
- **Valida** contra perfiles (US Core): que no falte la categoría de un lab, el nombre del paciente…
- **Explica** *qué* falló y *dónde* — "falta el segmento PV1 requerido para un ingreso" — sin abrir la spec.

El foso no es el protocolo MCP, es el **conocimiento de mapeo**: en vez de reglas escondidas en el
código, usa **mapas declarativos** ([`maps/`](maps/), YAML legible y versionable) del tipo
"PID-5 del mensaje → nombre del Patient". Traducción auditable y corregible sin tocar código.

## Tools

| Tool | Entrada | Salida |
|------|---------|--------|
| `parse_hl7v2` | `{ message }` | `{ ast }` — segmentos → campos → componentes, separadores leídos de MSH-1/2 |
| `map_v2_to_fhir` | `{ message, mapId?, fhirVersion? }` | `{ bundle, validation: { issues, explained } }` |
| `validate_message` | `{ payload, kind: "hl7v2"\|"fhir", profile? }` | `{ issues }` con `location` (segmento-campo o FHIRPath) |
| `explain_error` | `{ issue }` | `{ humanMessage, location, hint }` |

Mapas en v0.1: `ADT^A01`, `ORU^R01`, `ORM^O01` → FHIR R4 (ver [`maps/`](maps/)). Los mapeos no
obvios están marcados `TODO(mapeo)` y **no se adivinan**.

### Llamada → resultado (una por tool)

Cada tool se invoca vía `tools/call` con estos `arguments`. Salida resumida; el curl completo y
más casos (malformados, límite) en [USAGE.md](USAGE.md).

<details>
<summary><code>parse_hl7v2</code> — AST tipado, separadores leídos de MSH-1/2</summary>

```jsonc
// arguments
{ "message": "MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M" }
// → resultado
{ "ast": {
  "encoding": { "field":"|","component":"^","repetition":"~","escape":"\\","subcomponent":"&" },
  "segments": [ /* MSH, PID → campos → componentes → subcomponentes */ ]
} }
// mensaje que no empieza por MSH → isError: { "error": { "code":"INVALID_HEADER", "location":"MSH" } }
```
</details>

<details>
<summary><code>map_v2_to_fhir</code> — Bundle FHIR R4 + validación explicada</summary>

```jsonc
// arguments
{ "message": "MSH|...|ORU^R01|...\rPID|...\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F" }
// → resultado
{ "bundle": { "resourceType":"Bundle", "entry":[ /* Patient · Observation · DiagnosticReport */ ] },
  "validation": { "issues": [], "explained": [] } }        // limpio si cumple US Core
```
</details>

<details>
<summary><code>validate_message</code> — issues estructurales (v2) o de perfil (FHIR)</summary>

```jsonc
// arguments: un ADT^A01 sin PV1 ni nombre
{ "kind": "hl7v2", "payload": "MSH|...|ADT^A01|...\rEVN|A01|20260101\rPID|1||123456^^^H^MR" }
// → resultado
{ "issues": [
  { "severity":"error", "code":"MISSING_SEGMENT", "location":"PV1",  "message":"Falta el segmento requerido PV1 para ADT^A01." },
  { "severity":"error", "code":"MISSING_FIELD",   "location":"PID-5","message":"Falta el campo requerido PID-5 para ADT^A01." }
] }
```
</details>

<details>
<summary><code>explain_error</code> — enriquece un issue con lenguaje humano y tablas HL7</summary>

```jsonc
// arguments
{ "issue": { "severity":"information", "code":"CODED", "location":"OBX-11", "message":"OBX-11 tiene el valor 'F'." } }
// → resultado
{ "humanMessage": "OBX-11 tiene el valor 'F'. El valor 'F' significa \"Final\" (tabla HL7 0085).",
  "location": "OBX-11 (Estado del resultado de la observación)",
  "hint": "Revisa el mensaje de origen contra la especificación del perfil." }
```
</details>

## Pruébalo

Arranca en HTTP y llama a `map_v2_to_fhir` con un resultado de laboratorio:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
PORT=3999 npm run start:http &

curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F"}}}' | extract
```

Devuelve un `Bundle` con **Patient · Observation · DiagnosticReport** y validación limpia
(`"issues": []`). `Observation.category` = `laboratory` (que US Core exige) se puebla como
**constante deliberada documentada en el mapa** — HL7 v2 no tiene campo que la porte y un
`ORU^R01` es siempre laboratorio —, no un valor adivinado.

**El valor está en lo que avisa.** Con el mismo mensaje pero **sin PID-8 (sexo)**, `gender` sí
viene de un campo del mensaje, así que su ausencia es deuda real que la validación reporta con
`location` exacta y explicación humana:

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

La diferencia con `category` es de origen: `gender` tiene un campo v2 (PID-8) que se dejó vacío;
`category` es una constante sin campo. El set completo de pruebas de las 4 tools (válidos,
malformados, casos límite) está en [USAGE.md](USAGE.md).

## Uso

```bash
# Desarrollo
npm ci && npm test              # + npm run typecheck / lint / test:coverage

# stdio (clientes MCP locales, p. ej. Claude Desktop)
npm run build && npm start

# HTTP (Streamable HTTP para hosting): POST /mcp, health en /healthz, puerto $PORT
npm run build && npm run start:http
```

**Deploy en Render (free tier):** el repo incluye [`render.yaml`](render.yaml) como Blueprint.
El servicio hiberna tras ~15 min (primera petición ~30-60 s) y el endpoint **no tiene
autenticación** — úsalo solo con datos sintéticos.

## Principios de diseño

- **PHI-safe by default** — el repo nunca contiene PHI real; los logs redactan PID/NK1/GT1.
- **Herramientas estrechas** — cada tool tiene entrada/salida tipada, no un "haz lo que quieras".
- **Determinismo y explicabilidad** — todo error trae estructura + *qué* y *dónde* en lenguaje humano.
- **Fallar ruidosamente** — un mensaje malformado da error estructurado, nunca un resultado parcial silencioso.
- **No es un dispositivo médico** — sin decisiones clínicas sin validación humana.

## Stack y estructura

**TypeScript** (Node ≥ 20) estricto, SDK MCP oficial (`@modelcontextprotocol/sdk`), `fhirpath.js`
+ `@types/fhir`, Vitest. Errores tipados (`Hl7BridgeError` con `code`, `location`, `humanMessage`).

```
/src/{server,parser,mapper,validator,errors}   # MCP · HL7 v2 · mapeo declarativo · perfiles FHIR · errores
/maps                                          # mapas declarativos YAML (ADT, ORU, ORM…)
/test/fixtures                                 # mensajes sintéticos + salidas esperadas
```

Detalle en [`context/ARCHITECTURE.md`](context/ARCHITECTURE.md) (componentes, contratos I/O,
formato de mapas) y [`context/PRD.md`](context/PRD.md).

## Licencia

Apache-2.0 en el núcleo (parser, mapeador, validador, tools MCP). Ver [LICENSE](LICENSE).

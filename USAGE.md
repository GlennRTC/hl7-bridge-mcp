# HL7-Bridge MCP — Guía de uso y pruebas

Instrucciones para arrancar el servidor, invocar sus 4 tools y un set de mensajes de
prueba con el resultado esperado. Todos los ejemplos usan datos **sintéticos**.

> ⚠️ No es un dispositivo médico. No validado para decisiones clínicas.

## 1. Arranque

```bash
npm ci
npm run build
```

**stdio** (clientes MCP locales, p. ej. Claude Desktop):

```bash
npm start
```

Config para un cliente MCP por stdio:

```json
{
  "mcpServers": {
    "hl7-bridge": { "command": "node", "args": ["/ruta/al/repo/dist/server/index.js"] }
  }
}
```

**HTTP** (Streamable HTTP; también es lo que corre en Render):

```bash
PORT=3999 npm run start:http     # POST /mcp  ·  health en GET /healthz
```

## 2. Protocolo (HTTP)

El transporte es JSON-RPC 2.0 sobre `POST /mcp`. La cabecera `accept` debe incluir
`application/json` **y** `text/event-stream`; la respuesta llega como un evento SSE
(`data: {…}`). Métodos MCP estándar: `initialize`, `tools/list`, `tools/call`.

Listar las tools:

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Devuelve: `parse_hl7v2`, `map_v2_to_fhir`, `validate_message`, `explain_error`.

El resultado de cada tool viene en `result.content[0].text` como JSON serializado. Para
extraerlo en los ejemplos siguientes:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
```

## 3. Las 4 tools

### `parse_hl7v2` — `{ message }` → `{ ast }`
AST tipado con separadores leídos de MSH-1/MSH-2 (no se asume `|^~\&`).

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"parse_hl7v2","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102080000||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M"}}}' | extract
```

Resultado (recortado): `ast.encoding` = `{ field:"|", component:"^", repetition:"~", escape:"\\", subcomponent:"&" }`
y `ast.segments` = MSH, PID con sus campos → componentes → subcomponentes.

Un mensaje malformado devuelve `isError:true` con error tipado, p. ej. un mensaje que no
empieza por MSH → `{ "error": { "code":"INVALID_HEADER", "location":"MSH", "humanMessage":"…" } }`.

### `map_v2_to_fhir` — `{ message, mapId?, fhirVersion? }` → `{ bundle, validation }`
Mapea a un Bundle FHIR R4 y **valida** el resultado contra US Core mínimo, explicando cada issue.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102080000||ORU^R01|MSG1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1|845439|1045813|1554-5^GLUCOSE^LN|||20260102073000\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F|||20260102074500"}}}' | extract
```

Resultado esperado — un `Bundle` con `Patient` (identifier 123456, name DOE JOHN, gender male,
birthDate 1980-01-01) y `Observation` (status final, code 1554-5/GLUCOSE, valueQuantity 95 mg/dL,
effectiveDateTime 2026-01-02T07:45:00, subject → Patient). Y una validación que señala la
deuda de mapeo conocida:

```json
"validation": {
  "issues": [
    { "severity":"error", "code":"PROFILE_REQUIRED", "location":"Observation.category",
      "message":"US Core Observation requiere category." }
  ],
  "explained": [
    { "humanMessage":"US Core Observation requiere category.",
      "location":"Observation.category",
      "hint":"El perfil FHIR exige este elemento (must-support). Ajusta el mapa o el mensaje de origen para poblarlo." }
  ]
}
```

`fhirVersion:"R6"` devuelve `isError` (`UNSUPPORTED_VERSION`): en v0.1 solo hay R4.

### `validate_message` — `{ payload, kind, profile? }` → `{ issues }`
`kind:"hl7v2"` valida segmentos/campos requeridos por tipo de mensaje. `kind:"fhir"` recibe
un Bundle JSON (como string en `payload`) y valida contra US Core mínimo.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_message","arguments":{"kind":"hl7v2","payload":"MSH|^~\\&|HIS|H|EKG|H|20260101||ADT^A01|MSG1|P|2.5\rEVN|A01|20260101\rPID|1||123456^^^H^MR"}}}' | extract
```

Resultado esperado (ADT^A01 sin PV1 ni nombre):

```json
{ "issues": [
  { "severity":"error", "code":"MISSING_SEGMENT", "location":"PV1", "message":"Falta el segmento requerido PV1 para ADT^A01." },
  { "severity":"error", "code":"MISSING_FIELD",   "location":"PID-5", "message":"Falta el campo requerido PID-5 para ADT^A01." }
] }
```

### `explain_error` — `{ issue }` → `{ humanMessage, location, hint }`
Enriquece un issue: nombre legible del campo, significado de tablas HL7 y una pista.

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"explain_error","arguments":{"issue":{"severity":"information","code":"CODED","location":"OBX-11","message":"OBX-11 tiene el valor '"'"'F'"'"'."}}}}' | extract
```

Resultado esperado:

```json
{
  "humanMessage": "OBX-11 tiene el valor 'F'. El valor 'F' significa \"Final\" (tabla HL7 0085).",
  "location": "OBX-11 (Estado del resultado de la observación)",
  "hint": "Revisa el mensaje de origen contra la especificación del perfil."
}
```

## 4. Set de pruebas

Mensajes sintéticos y qué debe producir cada uno. Los `.hl7` de referencia están en
[`test/fixtures/`](test/fixtures/).

| # | Mensaje | Tool | Resultado esperado |
|---|---------|------|--------------------|
| 1 | `adt_a01.hl7` (válido) | `validate_message` (hl7v2) | `issues: []` |
| 2 | `oru_r01.hl7` (válido) | `validate_message` (hl7v2) | `issues: []` |
| 3 | `orm_o01.hl7` (válido) | `validate_message` (hl7v2) | `issues: []` |
| 4 | `invalid_adt_missing_name.hl7` | `validate_message` (hl7v2) | `MISSING_SEGMENT@PV1`, `MISSING_FIELD@PID-5` |
| 5 | `invalid_oru_missing_obr_code.hl7` | `validate_message` (hl7v2) | `MISSING_SEGMENT@OBR`, `MISSING_FIELD@OBX-3` |
| 6 | `oru_r01.hl7` | `map_v2_to_fhir` | Bundle Patient+Observation; issue `PROFILE_REQUIRED@Observation.category` |
| 7 | `orm_o01.hl7` | `map_v2_to_fhir` | Bundle Patient+ServiceRequest (status active, intent order, code 1554-5) |
| 8 | Mensaje sin MSH | `parse_hl7v2` | `isError` con `INVALID_HEADER@MSH` |
| 9 | Tipo `SIU^S12` (sin mapa) | `map_v2_to_fhir` | `isError` con `MAP_NOT_FOUND@MSH-9` |
| 10 | Separadores `:-+?*` no estándar | `parse_hl7v2` | `ast.encoding.field=":"`, resto según MSH-2 |

Casos límite cubiertos por los fixtures: repeticiones de campo (`~`, dos identificadores en
PID-3), subcomponentes (`&`), secuencias de escape (`\T\` → `&`), y finales de línea `\r`,
`\n`, `\r\n`.

### Smoke test end-to-end (HTTP)

Arranca el server (`PORT=3999 npm run start:http`) en otra terminal y ejecuta:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
post() { curl -s -X POST localhost:3999/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1" | extract; }

# ORU válido → Bundle + issue de category
post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||42||DOE^JOHN||19800101|M\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|||||F"}}}' | grep -q 'Observation.category' && echo 'PASS: map+validate' || echo 'FAIL'

# ADT inválido → dos issues
post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_message","arguments":{"kind":"hl7v2","payload":"MSH|^~\\&|HIS|H|EKG|H|20260101||ADT^A01|1|P|2.5\rEVN|A01|20260101\rPID|1||42"}}}' | grep -q 'MISSING_SEGMENT' && echo 'PASS: validate v2' || echo 'FAIL'
```

### Suite automatizada

La cobertura real de comportamiento vive en la suite Vitest (39 tests):

```bash
npm test               # todos
npm run test:coverage  # con gate ≥70% en parser y mapper
npx vitest run src/mapper/mapper.test.ts   # un archivo
```

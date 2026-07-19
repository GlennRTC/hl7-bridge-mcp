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

Resultado esperado — un `Bundle` con tres recursos:
- `Patient` (identifier 123456, name DOE JOHN, gender male, birthDate 1980-01-01).
- `Observation` (status final, `category` laboratory, code 1554-5/GLUCOSE con `system`
  `http://loinc.org`, valueQuantity 95 mg/dL, effectiveDateTime 2026-01-02T07:45:00, subject → Patient).
- `DiagnosticReport` (uno por OBR): `category` LAB (sistema `v2-0074`, distinto del de Observation),
  code 1554-5/GLUCOSE con `system` LOINC (OBR-4.3 = `LN`), `result[]` → la Observation del grupo,
  subject → Patient. `status` sale de OBR-25 (tabla 0123) si viene; en este mensaje OBR-25 está
  vacío, así que se omite (no se adivina).

La validación sale **limpia**: `"validation": { "issues": [], "explained": [] }`. `category=laboratory`
en la Observation es una constante deliberada (HL7 v2 no la porta; un ORU es siempre laboratorio) y
el `system` LOINC se deriva de OBX-3.3 = `LN` (tabla 0396).

**Deuda de mapeo — `CODING_NO_SYSTEM`.** Cuando un valor codificado (OBX tipo CE/CWE) trae un
sistema de codificación **no registrado** (ej. `99LOCAL`), el `system` no se adivina: el
`valueCodeableConcept.coding` sale con `code`+`display` pero sin `system`, y la validación lo
avisa como warning (no bloquea):

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

Si el mismo OBX usara `LN` en vez de `99LOCAL`, el `system` saldría `http://loinc.org` y no
habría warning. Un `Coding` sin `code` es error `CODING_EMPTY` (no solo warning).

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
| 6 | `oru_r01.hl7` | `map_v2_to_fhir` | Bundle Patient+Observation+DiagnosticReport (category laboratory/LAB, code con system LOINC, report `status` final de OBR-25, `result[]`→Observation); `issues: []` |
| 7 | `orm_o01.hl7` | `map_v2_to_fhir` | Bundle Patient+ServiceRequest (`status` active desde ORC-1=NW vía tabla 0119, intent order, code 1554-5) |
| 8 | Mensaje sin MSH | `parse_hl7v2` | `isError` con `INVALID_HEADER@MSH` |
| 9 | Tipo `SIU^S12` (sin mapa) | `map_v2_to_fhir` | `isError` con `MAP_NOT_FOUND@MSH-9` |
| 10 | Separadores `:-+?*` no estándar | `parse_hl7v2` | `ast.encoding.field=":"`, resto según MSH-2 |
| 11 | OBX `CE` con `Y^YELLOW^99LOCAL` | `map_v2_to_fhir` | `valueCodeableConcept.coding` sin `system`; warning `CODING_NO_SYSTEM` |
| 12 | `adt_a01.hl7` (PID-3 con MR + SS, PV1-2=`I`) | `map_v2_to_fhir` | Patient con **dos** identifier (`123456`/GENERAL_HOSPITAL y `999-99-9999`/USA); Encounter.class `IMP` (system `v3-ActCode`) |
| 13 | OBX `CWE` con coding alternativo (`…^LN^371244009^…^SCT`) | `map_v2_to_fhir` | `valueCodeableConcept.coding[0]` LOINC + `coding[1]` SNOMED (CWE.4/5/6) |

Casos límite cubiertos por los fixtures: repeticiones de campo (`~`, dos identificadores en
PID-3), subcomponentes (`&`), secuencias de escape (`\T\` → `&`), y finales de línea `\r`,
`\n`, `\r\n`.

### Smoke test end-to-end (HTTP)

Arranca el server (`PORT=3999 npm run start:http`) en otra terminal y ejecuta:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }
post() { curl -s -X POST localhost:3999/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1" | extract; }

# ORU con valor CE de sistema local → warning CODING_NO_SYSTEM
post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||42||DOE^JOHN||19800101|M\rOBR|1||1|5778-6^COLOR^LN\rOBX|1|CE|5778-6^COLOR^LN||Y^YELLOW^99LOCAL||||||F"}}}' | grep -q 'CODING_NO_SYSTEM' && echo 'PASS: map+validate' || echo 'FAIL'

# ADT inválido → dos issues
post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_message","arguments":{"kind":"hl7v2","payload":"MSH|^~\\&|HIS|H|EKG|H|20260101||ADT^A01|1|P|2.5\rEVN|A01|20260101\rPID|1||42"}}}' | grep -q 'MISSING_SEGMENT' && echo 'PASS: validate v2' || echo 'FAIL'
```

### Suite automatizada

La cobertura real de comportamiento vive en la suite Vitest (47 tests):

```bash
npm test               # todos
npm run test:coverage  # con gate ≥70% en parser y mapper
npx vitest run src/mapper/mapper.test.ts   # un archivo
```

# HL7-Bridge MCP

Servidor [MCP](https://modelcontextprotocol.io) que **parsea, mapea y valida** mensajes
clínicos entre **HL7 v2.x** y **FHIR R4**, con **explicación en lenguaje natural** de por
qué un mensaje no cumple un perfil. Pensado para que un agente de IA traduzca y valide
mensajes clínicos sin hablar directamente con un servidor FHIR crudo.

> ⚠️ **No es un dispositivo médico.** No está validado para decisiones clínicas. Los mapeos
> requieren validación humana antes de cualquier uso con datos reales. Ver [SECURITY.md](SECURITY.md).

## En palabras simples

Los sistemas de un hospital hablan dos "idiomas" distintos. **HL7 v2** es el idioma viejo y
telegráfico con el que, desde hace décadas, un equipo de laboratorio o de admisión anuncia
cosas como "ingresó el paciente Juan Pérez" o "el resultado de glucosa es 95 mg/dL". **FHIR**
es el idioma moderno, en JSON, que usan las apps, portales de paciente y sistemas nuevos.

Este proyecto es un **traductor entre esos dos idiomas** que, además, **revisa la traducción**
y explica los errores en lenguaje humano. Sirve para tres cosas:

1. **Traducir** un mensaje HL7 v2 al formato FHIR moderno (y a la inversa, en fases futuras).
2. **Validar** que el resultado cumple las reglas del estándar (perfiles como US Core): que no
   falte, por ejemplo, la categoría de una prueba de laboratorio o el nombre del paciente.
3. **Explicar** *qué* falló y *dónde* — "falta el segmento PV1 requerido para un ingreso" —
   en vez de un error críptico. Un desarrollador clínico no necesita abrir la especificación.

**Cómo lo hace:** en lugar de reglas de traducción escondidas en el código, usa **mapas
declarativos** (archivos [`maps/`](maps/) legibles y versionables) que dicen "PID-5 del mensaje
→ nombre del Patient en FHIR". Eso hace la traducción auditable y corregible sin tocar código.
Se expone como un servidor **[MCP](https://modelcontextprotocol.io)**, de modo que un agente de
IA (Claude, por ejemplo) puede pedirle traducir o validar un mensaje como una herramienta más.

## Tools

| Tool | Entrada | Salida |
|------|---------|--------|
| `parse_hl7v2` | `{ message }` | `{ ast }` — segmentos → campos → componentes, separadores leídos de MSH-1/2 |
| `map_v2_to_fhir` | `{ message, mapId?, fhirVersion? }` | `{ bundle, validation: { issues, explained } }` |
| `validate_message` | `{ payload, kind: "hl7v2"\|"fhir", profile? }` | `{ issues }` con `location` (segmento-campo o FHIRPath) |
| `explain_error` | `{ issue }` | `{ humanMessage, location, hint }` |

Mapas soportados en v0.1: `ADT^A01`, `ORU^R01`, `ORM^O01` → FHIR R4 (ver [`maps/`](maps/)).
Los mapeos no obvios están marcados `TODO(mapeo)` y no se adivinan.

## Probar el MCP: un ejemplo

Un mensaje HL7 v2 de resultado de laboratorio (glucosa) traducido a FHIR. Arranca el server en
HTTP (`PORT=3999 npm run start:http`) y llama a `map_v2_to_fhir`:

```bash
extract() { sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])'; }

curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|M\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F"}}}' | extract
```

**Qué devuelve:** un `Bundle` FHIR con dos recursos y una validación limpia —

- `Patient`: identifier `123456`, name `DOE JOHN`, gender `male`, birthDate `1980-01-01`.
- `Observation`: status `final`, code `1554-5` (GLUCOSE), valueQuantity `95 mg/dL`,
  `category` = `laboratory`, subject → el Patient.

```json
"validation": { "issues": [], "explained": [] }
```

La validación pasa sin issues: `Observation.category` (que US Core exige) se puebla como
constante `laboratory`, porque HL7 v2 no tiene ningún campo que la porte y un `ORU^R01` es
siempre laboratorio. Es una **asunción deliberada documentada en el mapa** ([`maps/oru_r01_to_fhir_r4.yaml`](maps/oru_r01_to_fhir_r4.yaml)),
no un valor adivinado de un campo del mensaje.

### Segundo ejemplo: un mensaje que sí genera deuda

El mismo mensaje, pero **sin el sexo del paciente** (PID-8 vacío). US Core exige `gender` y
ese sí viene de un campo del mensaje, así que su ausencia es una deuda real que la validación
reporta:

```bash
curl -s -X POST localhost:3999/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"map_v2_to_fhir","arguments":{"message":"MSH|^~\\&|LAB|H|EMR|H|20260102||ORU^R01|1|P|2.5\rPID|1||123456^^^H^MR||DOE^JOHN||19800101|\rOBR|1||1|1554-5^GLUCOSE^LN\rOBX|1|NM|1554-5^GLUCOSE^LN||95|mg/dL|70-105|N|||F"}}}' | extract
```

El `Bundle` sale igual salvo que el `Patient` ya no trae `gender`, y la validación lo señala:

```json
"validation": {
  "issues": [
    { "severity":"error", "code":"PROFILE_REQUIRED", "location":"Patient.gender",
      "message":"US Core Patient requiere gender." }
  ],
  "explained": [
    { "humanMessage":"US Core Patient requiere gender.",
      "location":"Patient.gender",
      "hint":"El perfil FHIR exige este elemento (must-support). Ajusta el mapa o el mensaje de origen para poblarlo." }
  ]
}
```

Esto es lo valioso: no solo tradujo, también avisó *qué falta y por qué* — con `location`
exacta — en lenguaje humano. La diferencia con `category` es de origen: `gender` sí tiene un
campo v2 (PID-8) que se dejó vacío, mientras `category` es una constante sin campo de origen.

El set de pruebas completo de las 4 tools (con mensajes válidos, malformados y casos límite)
está en [USAGE.md](USAGE.md).

## Desarrollo

```bash
npm ci
npm run typecheck   # tsc estricto
npm run lint
npm test            # vitest
npm run test:coverage
```

## Ejecución

**stdio** (clientes MCP locales, p. ej. Claude Desktop):

```bash
npm run build && npm start
```

**HTTP** (Streamable HTTP, para hosting):

```bash
npm run build && npm run start:http   # POST /mcp, health en /healthz, puerto $PORT
```

### Deploy en Render (free tier)

El repo incluye [`render.yaml`](render.yaml) como Blueprint. Conecta el repo en Render y
desplegará un Web Service con `POST /mcp`. Notas del plan gratuito:

- El servicio **hiberna** tras ~15 min de inactividad; la primera petición tras dormir tarda ~30-60 s.
- El endpoint **no tiene autenticación**: úsalo solo con datos sintéticos.

## Qué es este proyecto

No es un CRUD FHIR más: es la *capa de traducción validada* que un agente necesita para no
hablar directamente con un servidor FHIR crudo. El diferenciador es el mapeo **declarativo**
(mapas versionables) + validación contra perfiles (US Core, IPS) + explicación de por qué
falla un mensaje. El foso es el conocimiento de mapeo y los *vendor quirks* de HL7 v2, no el
protocolo MCP.

## Principios de diseño (no negociables)

1. **PHI-safe by default.** El repositorio NUNCA contiene PHI real. Todos los fixtures son
   sintéticos o de dominio público. Los logs redactan por defecto cualquier campo con datos
   de paciente (PID, NK1, GT1). Nunca se imprime un mensaje completo en logs de nivel INFO.
2. **Herramientas estrechas, no genéricas.** Cada tool MCP tiene entrada/salida tipada y
   documentada, en lugar de un "haz lo que quieras".
3. **Determinismo y explicabilidad.** Ante un error de validación, se devuelve estructura +
   explicación humana: *qué* falló y *dónde* (segmento-campo-componente) sin abrir la spec.
4. **No es un dispositivo médico.** No se usa para decisiones clínicas sin validación humana.
5. **Fallar ruidosamente en parsing, silenciosamente nunca.** Un mensaje malformado produce
   un error estructurado, jamás un resultado parcial silencioso.

## Stack

**TypeScript** (Node ≥ 20), SDK MCP oficial (`@modelcontextprotocol/sdk`), ecosistema FHIR en
JS (`fhirpath.js`, `@types/fhir`). Tests con Vitest. TypeScript estricto (`strict`,
`noUncheckedIndexedAccess`); errores tipados (`Hl7BridgeError` con `code`, `location`,
`humanMessage`).

## Estructura del repositorio

```
/src
  /server        # arranque MCP, registro de tools
  /parser        # HL7 v2: segmentos, campos, componentes, tablas
  /mapper        # motor de mapeo declarativo v2<->FHIR
  /validator     # validación FHIR (perfiles) + explicación
  /errors        # tipos de error
/maps            # mapas declarativos (YAML): ADT, ORU, ORM...
/test/fixtures   # mensajes sintéticos + salidas esperadas
```

Ver [`context/ARCHITECTURE.md`](context/ARCHITECTURE.md) (componentes, contratos de I/O,
formato de mapas) y [`context/PRD.md`](context/PRD.md) para el detalle.

## Licencia

Apache-2.0 en el núcleo (parser, mapeador, validador, tools MCP). Ver [LICENSE](LICENSE).

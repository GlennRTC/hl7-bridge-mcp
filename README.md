# HL7-Bridge MCP

Servidor [MCP](https://modelcontextprotocol.io) que **parsea, mapea y valida** mensajes
clínicos entre **HL7 v2.x** y **FHIR R4**, con **explicación en lenguaje natural** de por
qué un mensaje no cumple un perfil. Pensado para que un agente de IA traduzca y valide
mensajes clínicos sin hablar directamente con un servidor FHIR crudo.

> ⚠️ **No es un dispositivo médico.** No está validado para decisiones clínicas. Los mapeos
> requieren validación humana antes de cualquier uso con datos reales. Ver [SECURITY.md](SECURITY.md).

## Tools

| Tool | Entrada | Salida |
|------|---------|--------|
| `parse_hl7v2` | `{ message }` | `{ ast }` — segmentos → campos → componentes, separadores leídos de MSH-1/2 |
| `map_v2_to_fhir` | `{ message, mapId?, fhirVersion? }` | `{ bundle, validation: { issues, explained } }` |
| `validate_message` | `{ payload, kind: "hl7v2"\|"fhir", profile? }` | `{ issues }` con `location` (segmento-campo o FHIRPath) |
| `explain_error` | `{ issue }` | `{ humanMessage, location, hint }` |

Mapas soportados en v0.1: `ADT^A01`, `ORU^R01`, `ORM^O01` → FHIR R4 (ver [`maps/`](maps/)).
Los mapeos no obvios están marcados `TODO(mapeo)` y no se adivinan.

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

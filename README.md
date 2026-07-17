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

## Diseño

Ver [`context/ARCHITECTURE.md`](context/ARCHITECTURE.md) (componentes, contratos de I/O,
formato de mapas) y [`context/PRD.md`](context/PRD.md). Principios no negociables en
[`CLAUDE.md`](CLAUDE.md): PHI-safe por defecto, herramientas estrechas, determinismo y
explicabilidad, fallar ruidosamente en parsing.

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).

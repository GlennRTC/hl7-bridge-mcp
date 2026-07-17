# CLAUDE.md — HL7-Bridge MCP

> Constitución del proyecto. Léela completa antes de escribir código. Rige el comportamiento del agente en todo el repositorio.

## Estado actual
Repo pre-código: solo existen este archivo, `context/ARCHITECTURE.md` (componentes, contratos de tools I/O, formato de mapas YAML, bitácora de decisiones) y `context/PRD.md` (problema, requisitos, no-objetivos v1). Aún no hay `package.json` ni código; el primer paso de implementación es el scaffolding TS (ver stack abajo). Cuando existan comandos de build/test, documentarlos aquí.

## Qué es este proyecto
Servidor **MCP** (Model Context Protocol) + SDK que permite a agentes de IA **parsear, mapear y validar** mensajes clínicos entre **HL7 v2.x** y **FHIR R4/R6**, con **explicabilidad** de errores en lenguaje natural. No es un CRUD FHIR más: es la *capa de traducción validada* que un agente necesita para no hablar directamente con un servidor FHIR crudo.

Diferenciador: mapeo **declarativo** (mapas versionables) + validación contra perfiles (US Core, IPS) + explicación de por qué falla un mensaje. El foso es el conocimiento de mapeo y los *vendor quirks* de HL7 v2, no el protocolo MCP.

## Principios de diseño (no negociables)
1. **PHI-safe by default.** El repositorio NUNCA contiene PHI real. Todos los fixtures son sintéticos o de dominio público (ej. mensajes de ejemplo de la spec HL7). Los logs redactan por defecto cualquier campo con datos de paciente (PID, NK1, GT1). Nunca imprimir un mensaje completo en logs de nivel INFO.
2. **Herramientas estrechas, no genéricas.** Preferir `map_v2_to_fhir` con contrato claro sobre un "haz lo que quieras". Cada tool MCP tiene entrada/salida tipada y documentada.
3. **Determinismo y explicabilidad.** Ante un error de validación, devolver estructura + explicación humana. Un ingeniero debe entender *qué* falló y *dónde* (segmento-campo-componente) sin abrir la spec.
4. **No es un dispositivo médico.** No se usa para decisiones clínicas sin validación del usuario. Incluir disclaimer en README y en respuestas que lo ameriten.
5. **Fallar ruidosamente en parsing, silenciosamente nunca.** Un mensaje malformado produce un error estructurado, jamás un resultado parcial silencioso.

## Stack recomendado (con tradeoff explícito)
- **Recomendado: TypeScript** (Node ≥ 20). Razón: SDK MCP oficial (`@modelcontextprotocol/sdk`) es el más maduro; ecosistema FHIR en JS sólido (`fhirpath.js`, `fhir` npm, `@types/fhir`); iteración rápida.
- **Alternativa: Rust** (`rmcp`, SDK MCP oficial de Rust). Mejor rendimiento en parsing masivo y binarios distribuibles, pero SDK MCP menos maduro y ecosistema FHIR de validación más pobre. **Decisión de Glenn pendiente** — arrancar en TS y extraer el parser a Rust vía sidecar si el rendimiento lo exige.

No cambies de stack sin registrar la decisión en `context/ARCHITECTURE.md` (sección Decisiones).

## Convenciones de código
- TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`). Sin `any` salvo justificado con comentario.
- Comentarios mínimos y compactos; el código se explica solo. Documentar solo lo no obvio (un *quirk* de vendor, una desviación de la spec).
- Nombres de tools MCP en `snake_case`; código en `camelCase`; tipos en `PascalCase`.
- Tests con Vitest. Todo parser/mapeador nuevo llega con fixtures de entrada + salida esperada.
- Errores tipados (clase `Hl7BridgeError` con `code`, `location`, `humanMessage`). Nunca `throw new Error("string suelto")`.

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
SECURITY.md
```

## Herramientas MCP a exponer (contrato)
Ver `context/ARCHITECTURE.md` para I/O detallado. Núcleo mínimo (MVP):
`parse_hl7v2`, `map_v2_to_fhir`, `validate_message`, `explain_error`.
Fase 2: `map_fhir_to_v2`, `diff_messages`, `list_maps`, `get_map`, `generate_map_skeleton`.

## Reglas para el agente (Claude Code)
- Antes de implementar una tool, escribe primero su contrato de tipos y un fixture de test. TDD ligero.
- No inventes campos de mapeo. Si un mapeo v2→FHIR no es obvio, márcalo `TODO(mapeo): requiere validación de Glenn` en el mapa YAML y no lo adivines.
- Si tocas terminología (LOINC, SNOMED), NO incluyas datos con licencia en el repo. Usa códigos de ejemplo y referencia el servicio externo.
- Respeta `PHI-safe by default` en cada PR.

## Licencia y estrategia
Apache-2.0 en el núcleo (parser, mapeador, validador, tools MCP). Capa comercial futura (fuera de este repo): packs de mapeo certificados por dominio, versión hosted con BAA, "mapping studio" visual. No mezclar código comercial aquí.

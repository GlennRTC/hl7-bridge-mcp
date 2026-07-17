# Security Policy

## PHI-safe by default
Este repositorio **nunca** contiene PHI (Protected Health Information) real. Todos
los fixtures son sintéticos o de dominio público (mensajes de ejemplo de la spec HL7).

- Los nombres, identificadores y fechas de los fixtures son inventados.
- Los logs redactan por defecto los segmentos con datos de paciente (`PID`, `NK1`, `GT1`).
  El cuerpo de un mensaje solo se registra con `DEBUG_HL7` activo, y siempre redactado.
- Ningún log de nivel `INFO` imprime un mensaje completo.

Si vas a procesar datos reales, no los añadas al repo ni a los logs. El transporte
HTTP del prototipo **no incluye autenticación** y está pensado solo para datos sintéticos.

## No es un dispositivo médico
Esta herramienta no está validada para decisiones clínicas. Ver el disclaimer del README.

## Reportar una vulnerabilidad
Reporta de forma privada a **glenn.r.tomassi@gmail.com** con:
- Descripción y pasos de reproducción.
- Impacto potencial (incluye si hay riesgo de exposición de PHI).

No abras un issue público para vulnerabilidades. Respuesta esperada en ~72 h.

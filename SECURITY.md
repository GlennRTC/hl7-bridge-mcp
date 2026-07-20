# Security Policy

## PHI-safe by default
This repository **never** contains real PHI (Protected Health Information). All
fixtures are synthetic or public domain (example messages from the HL7 spec).

- The names, identifiers and dates in the fixtures are made up.
- Logs redact segments with patient data (`PID`, `NK1`, `GT1`) by default.
  A message body is only logged with `DEBUG_HL7` enabled, and always redacted.
- No `INFO`-level log prints a full message.

If you are going to process real data, do not add it to the repo or the logs. The prototype's
HTTP transport **includes no authentication** and is intended for synthetic data only.

## Not a medical device
This tool is not validated for clinical decisions. See the README disclaimer.

## Reporting a vulnerability
Report privately to **glenn.r.tomassi@gmail.com** with:
- Description and reproduction steps.
- Potential impact (include whether there is a risk of PHI exposure).

Do not open a public issue for vulnerabilities. Expected response within ~72 h.

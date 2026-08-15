---
"@openagentpack/sdk": minor
"@openagentpack/playground": minor
"@openagentpack/cli": minor
---

Replace the fixed Playbook showcase with an `agents.yaml` project debugger. Playground now watches project inputs, performs fingerprint-protected per-Agent Plan and Apply operations, streams operation and Session events, and manages explicit temporary attachment cleanup without mutating YAML or Deployment declarations.

Add SDK source-path tracking, runtime-scoped Agent planning, stable plan fingerprints, and stale-plan enforcement. The CLI now launches Preview with `agents playground -f/--file [--agent <id>]`, exposes the project console separately through `agents workbench`, and falls back to the diagnostic Workbench for missing, invalid, empty, or unselected multi-Agent projects; the former `playground --provider` option is removed.

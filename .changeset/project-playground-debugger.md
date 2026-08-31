---
"@openagentpack/sdk": minor
"@openagentpack/playground": minor
"@openagentpack/cli": minor
---

Replace the fixed Playbook showcase with project-aware debugging. `agents playground` remains a read-only `agents.yaml` Session Preview, while `agents project workbench` watches and edits a directory project, performs fingerprint-protected Build/Plan/Publish operations, streams operation and Session events, and manages explicit temporary attachment cleanup.

Add SDK source-path tracking, runtime-scoped Agent planning, full-project planning, stable plan fingerprints, and stale-plan enforcement. Preview stays at `agents playground -f/--file [--agent <id>]`; the project console moves under `agents project workbench --project <directory>`.

---
"@openagentpack/sdk": patch
---

Support Bailian builtin-tool approval policies during validation and Agent create/update. Preserve toolkit defaults and per-tool overrides in provider requests and exports, detect effective approval changes during drift comparison, and retain legacy allow-only comparison baselines. Reject effective approval policies on project-declared subagents and delegated Self; fail closed when an implicitly enabled remote tool catalogue cannot be exported losslessly.

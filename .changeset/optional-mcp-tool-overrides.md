---
"@openagentpack/sdk": patch
---

Allow MCP toolkit configs and agent-builder tool overrides to be omitted or empty. Bailian requests normalize missing overrides to an empty array, so default_config.enabled can enable all MCP tools without placeholder names. Preserve the disabled default and explicit per-tool overrides.

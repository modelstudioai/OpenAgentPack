---
"@openagentpack/sdk": minor
---

Default declarative memory entries to initialization of newly created stores only. Existing, imported, or adopted stores retain their runtime content, and initialization-only entry changes no longer schedule updates. Add entries_mode: sync as an explicit opt-in to the previous continuous YAML synchronization behavior.

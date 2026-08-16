---
"@openagentpack/sdk": minor
"@openagentpack/cli": minor
"@openagentpack/playground": minor
---

Add `mode: pairing` support for Qoder Channels.

`channels[].mode` now accepts `fixed` (default) or `pairing`. Pairing-mode channels create a transport-only IM connection without binding to an Identity or Template, which is required for Forward Schedule sinks such as scheduled group broadcasts. Fixed-mode channels retain the existing behavior and continue to require `agent` and `identity`.

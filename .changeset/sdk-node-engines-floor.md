---
"@openagentpack/sdk": patch
---

Lower the SDK `engines` floor from Node `>=22` to `>=18.17.0`.

The SDK runtime only relies on APIs available since Node 18.17 (`node:fs`/`path`/`crypto`/`os`, global `fetch`/`FormData`, `structuredClone`, web streams), so the previous floor was a repository baseline rather than a runtime requirement. The tsup build target is pinned to `es2022` so emitted syntax stays parseable on the new floor, and CI now runs an SDK-only packed-install smoke on Node 18 and 20 (`smoke-packed.ts --sdk-only`) to enforce the contract. The `@openagentpack/cli` and `@openagentpack/playground` packages keep their Node `>=22` requirement.

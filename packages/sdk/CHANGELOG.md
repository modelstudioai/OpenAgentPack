# @openagentpack/sdk

## 0.5.0

### Minor Changes

- 8b0718d: Expose Bailian Managed Agents operation-level reads, cursor pagination, session events, file downloads, deployment actions, provider capability metadata, generic scoped create-only planning/apply, local Skill source inspection, scoped Vault Credential creation, and display names independent from logical YAML keys.

## 0.4.0

### Minor Changes

- 407cc75: Add `mode: pairing` support for Qoder Channels.

  `channels[].mode` now accepts `fixed` (default) or `pairing`. Pairing-mode channels create a transport-only IM connection without binding to an Identity or Template, which is required for Forward Schedule sinks such as scheduled group broadcasts. Fixed-mode channels retain the existing behavior and continue to require `agent` and `identity`.

## 0.3.2

### Patch Changes

- e74f023: Bailian: implement native Deployment support against the Agent Studio `/deployments` API (create, get, list, update, archive, run, pause/unpause), replacing the previous emulated session expansion. Deployment schedules now run server-side; `user.define_outcome` events and `github_repository` resources are dropped from the deployment payload and surface a warning on plan.

## 0.3.1

### Patch Changes

- 32778d4: Lower the SDK `engines` floor from Node `>=22` to `>=18.17.0`.

  The SDK runtime only relies on APIs available since Node 18.17 (`node:fs`/`path`/`crypto`/`os`, global `fetch`/`FormData`, `structuredClone`, web streams), so the previous floor was a repository baseline rather than a runtime requirement. The tsup build target is pinned to `es2022` so emitted syntax stays parseable on the new floor, and CI now runs an SDK-only packed-install smoke on Node 18 and 20 (`smoke-packed.ts --sdk-only`) to enforce the contract. The `@openagentpack/cli` and `@openagentpack/playground` packages keep their Node `>=22` requirement.

## 0.3.0

### Minor Changes

- 24e5370: Add a portable Memory Store and Memory lifecycle API across Qoder, Claude, and
  Volcengine Ark, including provider capability differences, CLI commands,
  declarative entry reconciliation, version history, and Ark batch creation.

## 0.2.0

### Minor Changes

- fd1cf3b: Add BYOC runtime, session, vault, and Qoder deployment capabilities, including native deployments, tunnels, and forward templates.

## 0.1.1

### Patch Changes

- ba1af83: Classify Agent readiness from structured plan impact and changed paths instead of parsing display text.

## 0.1.0

### Minor Changes

- 06f8527: Require maintained Node.js releases (22 or newer) and certify published packages on Linux, Windows, and macOS before creating a GitHub Release.

## 0.0.2

### Patch Changes

- 86c1ff1: release 0.0.1

## 0.0.2-beta.0

### Patch Changes

- release 0.0.1

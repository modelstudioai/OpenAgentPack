# @openagentpack/playground

## 0.6.0

### Minor Changes

- 8c6a767: Replace the fixed Playbook showcase with project-aware debugging. `agents playground` remains a read-only `agents.yaml` Session Preview, while `agents project workbench` watches and edits a directory project, performs fingerprint-protected Build/Plan/Publish operations, streams operation and Session events, and manages explicit temporary attachment cleanup.

  Add SDK source-path tracking, runtime-scoped Agent planning, full-project planning, stable plan fingerprints, and stale-plan enforcement. Preview stays at `agents playground -f/--file [--agent <id>]`; the project console moves under `agents project workbench --project <directory>`.

- f956bad: Publish a directory workspace service for deterministic Build/Publish and a
  Git-independent full source-tree snapshot engine. CLI and Workbench share one
  versioning switch, content-addressed text/binary blobs, forward restore, and a
  cross-process mutation lock while remote State remains excluded. Project Build
  previews now show full directory source changes against the current version HEAD.
- bcb185b: Add Workbench editing and removal for resources already present in a directory project. Agent JSON, instructions Markdown, Skill metadata/content, and project resources use server-side redacted previews, revision conflicts, reference protection, explicit Build, full-project Plan, and separately confirmed Publish.

### Patch Changes

- Updated dependencies [8c6a767]
- Updated dependencies [f956bad]
  - @openagentpack/sdk@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [8b0718d]
  - @openagentpack/sdk@0.5.0

## 0.4.0

### Minor Changes

- 407cc75: Add `mode: pairing` support for Qoder Channels.

  `channels[].mode` now accepts `fixed` (default) or `pairing`. Pairing-mode channels create a transport-only IM connection without binding to an Identity or Template, which is required for Forward Schedule sinks such as scheduled group broadcasts. Fixed-mode channels retain the existing behavior and continue to require `agent` and `identity`.

### Patch Changes

- Updated dependencies [407cc75]
  - @openagentpack/sdk@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [e74f023]
  - @openagentpack/sdk@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [32778d4]
  - @openagentpack/sdk@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [24e5370]
  - @openagentpack/sdk@0.3.0

## 0.2.0

### Minor Changes

- fd1cf3b: Add BYOC runtime, session, vault, and Qoder deployment capabilities, including native deployments, tunnels, and forward templates.

### Patch Changes

- Updated dependencies [fd1cf3b]
  - @openagentpack/sdk@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [ba1af83]
  - @openagentpack/sdk@0.1.1

## 0.1.0

### Minor Changes

- 06f8527: Require maintained Node.js releases (22 or newer) and certify published packages on Linux, Windows, and macOS before creating a GitHub Release.

### Patch Changes

- Updated dependencies [06f8527]
  - @openagentpack/sdk@0.1.0

## 0.0.2

### Patch Changes

- 86c1ff1: release 0.0.1
- Updated dependencies [86c1ff1]
  - @openagentpack/sdk@0.0.2

## 0.0.2-beta.0

### Patch Changes

- release 0.0.1
- Updated dependencies
  - @openagentpack/sdk@0.0.2-beta.0

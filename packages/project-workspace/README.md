# @openagentpack/project-workspace

Node.js services for OpenAgentPack directory projects. The package scans and
validates project source files, builds the generated `agents.yaml`, coordinates
Publish, and adapts directory snapshots to `@openagentpack/project-versions`.

Build output, remote state, and local version blobs live below `.openagentpack/`
and are not project source.

# @openagentpack/project-workspace

Node.js services for OpenAgentPack directory projects. The package scans and
validates project source files, builds the generated `agents.yaml`, coordinates
Publish, and adapts directory snapshots to `@openagentpack/project-versions`.

Build output, remote state, and local version blobs live below `.openagentpack/`
and are not project source.

Managed resource declarations are directory-owned rather than stored in
`project.json`. An Agent can own Environment, Vault, Memory Store, and File
declarations below its directory:

```text
agents/<agent-id>/
  agent.json
  instructions.md
  environments/<id>/environment.json
  vaults/<id>/vault.json
  memory-stores/<id>/memory-store.json
  files/<id>/file.json
  skills/<id>/skill.json
```

Resources used outside their owning Agent are promoted during Build to
`resources/<resource-type>/<id>/`. An Agent mounts a declared File into every
new Session by adding `{ "file": "<id>", "mount_path": "/mnt/<name>" }` to the
`files` array in `agent.json`; Build promotes a File when multiple Agents
reference it. Directory projects always use the Bailian provider. `project.json`
does not declare `providers` or `defaults.provider`; Build supplies the Bailian
provider from `DASHSCOPE_API_KEY` and `BAILIAN_BASE_URL`. It also rejects
`agents`, `skills`, `environments`, `vaults`, `memory_stores`, and `files`
sections.

`initializeDirectoryProject` accepts an optional `environment` map. When
provided, initialization writes it to a new `.env` with mode `0600`, adds
`.env` to `.gitignore`, and excludes the file from directory snapshots. An
existing `.env` is preserved.

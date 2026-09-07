# @openagentpack/project-workspace

Node.js services for OpenAgentPack directory projects. The package scans and
validates project source files, builds the generated `agents.yaml`, coordinates
Publish, and adapts directory snapshots to `@openagentpack/project-versions`.

Build output, remote state, and local version blobs live below `.openagentpack/`
and are not project source.

Fresh `project init` also scaffolds inert, bilingual examples:

```text
agents/assistant/
  agent.json
  instructions.md
  skills/_examples/example-skill/{skill.json,SKILL.md,README.md}
  files/_examples/example-file/{file.json,example.md,README.md}
  vaults/_examples/example-vault/{vault.json,README.md}
  environments/_examples/example-env/{environment.json,README.md}
```

`agent.json` does not reference these examples. Resource discovery skips the
reserved `_examples/` child directory (both Agent-local and shared resources),
so the examples never become generated YAML declarations or remote Publish
actions, even when they contain normal `skill.json`, `file.json`, or `SKILL.md`.
To enable one, copy its resource directory outside `_examples/` and configure
its Agent reference using the included README. Vault placeholders are only
resolved after enabling. Examples remain local versioned source; never put
real credentials in them. Init does not inject examples when converting an
existing YAML project, overwrite an existing project, or run Build/Publish.

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
`resources/<resource-type>/<id>/`. Agent-local File and Skill content supports
convention-based association during Build:

- A file copied directly to `agents/<agent-id>/files/<name>` is moved to
  `files/<resource-id>/<name>`, receives a generated `file.json`, and is added
  to `agent.json.files` at `/mnt/<name>`.
- A pre-created `agents/<agent-id>/files/<resource-id>/` directory containing
  exactly one content file can also omit `file.json`; Build generates the
  metadata in place and adds the same Agent mount.
- A `skills/<skill-id>/` directory containing `SKILL.md` can omit `skill.json`;
  Build generates it and adds the Skill to `agent.json.skills`. Other files in
  that directory remain part of the Skill source.

Explicit metadata and Agent references always win and are never overwritten by
inference. File uploads use the original basename of `file.json.source`, including
its extension; `file.json.name` is a local label and does not rename the uploaded
file or determine its MIME type. For example, `source: "./reference.md"` with
`name: "Assistant Reference"` uploads as `reference.md`.
文件上传保留 `source` 的原始文件名和扩展名；`name` 仅作为本地名称，不覆盖上传文件名。

Workbench leaves `.openagentpack-ignore` beside the source when it
removes a File declaration, so a later Build does not recreate it. Build
promotes an Agent-local resource when another Agent references
it. Directory projects always use the Bailian provider. `project.json` does not
declare `providers` or `defaults.provider`; Build supplies the Bailian provider
from `DASHSCOPE_API_KEY` and `BAILIAN_BASE_URL`. It also rejects `agents`,
`skills`, `environments`, `vaults`, `memory_stores`, and `files` sections.

Build moves literal Vault credential `secret_value` / `access_token` values from
Agent-local or shared `vault.json` into the project-root `.env`, replacing them
with `${AGENTS_VAULT_...}` references. Existing references are unchanged.
Names are deterministic; conflicting names receive a suffix, existing `.env`
entries/comments are retained, and secrets are never printed. `.env` is written
atomically with owner-only permissions; Vault JSON keeps its original mode.
Preview and dry-run show proposed references without writing files. Invalid
projects, symlinked `.env`, ambiguous dotenv syntax, and values that cannot
round-trip through dotenv are rejected before migration.

Publish and Workbench runtime resolution read the selected project's root `.env`
as a fallback to the process environment, without changing global environment
variables. Changes are read again on the next resolution. `.env` stays out of
source revisions and local version snapshots: restore keeps the current `.env`,
so keep it backed up securely. Add `.env` to your own Git ignore rules; Build does
not configure Git. `.env` is plaintext local storage, not an encrypted vault.

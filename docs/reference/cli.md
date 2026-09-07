# CLI reference

The `agents` command. This page documents every command and option defined in `packages/cli/src/program.ts`.

## Global options

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Path to the config file. Defaults to `agents.yaml`. |
| `-v, --verbose` | Increase logging verbosity. Repeat: `-vv`. |
| `-q, --quiet` | Suppress non-error output. |
| `--no-color` | Disable colored output. |
| `-V, --version` | Print the CLI version. |

Provider-backed commands such as `plan`, `apply`, `models`, `session`, and `deployment` accept `--provider <name>` to target a single provider. `validate` is an offline whole-file check and does not accept a provider filter. Run `agents <command> --help` for the definitive option list.

## `agents init`

Create a new `agents.yaml` template via an interactive wizard (provider selection + agent name). Appends `agents.state.json`, `.openagentpack/versions/`, and `.env` to `.gitignore`.

| Option | Description |
|--------|-------------|
| `--provider <provider>` | Configure `bailian`, `claude`, `qoder`, `ark`, or `all` without prompting. |
| `--agent-name <name>` | Set the first Agent name without prompting. |

## `agents playground`

Launch the local web UI and open an `agents.yaml` Agent directly in Preview.

Playground opens the project selected by `-f`, watches the YAML and its local dependencies, and uses each Agent's declared Provider. A single Agent is selected automatically. For multiple Agents, pass `--agent <id>`; otherwise the Workbench opens for selection. Missing or invalid projects also open the diagnostic Workbench.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Project configuration to open (default `agents.yaml`). |
| `--agent <id>` | Agent to preview (required for direct Preview when multiple Agents are declared). |
| `--port <n>` | Port to serve on (default `4848`). |
| `--no-open` | Do not open a browser automatically. |


The YAML Preview flow is read-only and does not participate in directory project Build, Publish, or versions.

## `agents project`

Manage a Bailian directory project. `project.json` contains project-wide metadata but does not declare a Provider; Build always supplies `bailian` using `${DASHSCOPE_API_KEY}` and `${BAILIAN_BASE_URL}`. Agent declarations and owned resources live below `agents/<id>/`: `agent.json`, `instructions.md`, `skills/`, `environments/`, `vaults/`, `memory-stores/`, and `files/`. For Agent-local content, Build can generate `skill.json` from a Skill directory containing `SKILL.md`, or generate `file.json` and a `/mnt/<name>` mount from either a directly copied File or a resource-ID directory containing one content file. It also writes the inferred reference to `agent.json`; explicit metadata and references always win. Resources referenced outside their owning Agent are promoted during Build to root `resources/` directories. `.openagentpack/` contains generated Build output, remote State, versions, locks, and recoverable trash; it is not authored source.

| Subcommand | Description |
|------------|-------------|
| `project init` | Create a directory project with inactive Skill/File/Vault/Environment examples under each resource directory's `_examples/`, or convert an existing root `agents.yaml` without deleting it. Creates and enables the baseline source version. |
| `project validate` | Validate all authored JSON, Markdown, Skill, and referenced local files without remote mutation. |
| `project build` | Preview full directory source changes against the current version HEAD, or write deterministic `.openagentpack/build/agents.yaml`; shared Skill and managed-resource promotion happens only here. |
| `project publish` | Plan and publish the current Build, then record the frozen source revision after complete success. Never runs Build implicitly. |
| `project workbench` | Open the directory project Workbench. |
| `project version ...` | Inspect, enable/disable, preview, or restore Git-independent full-tree versions. |

All project subcommands accept `--project <directory>` (default current directory). `project build --dry-run` shows version-backed directory source changes and proposed organization moves; writing requires `--yes` or interactive confirmation. `project publish` requires a current Build and explicit confirmation, includes Deployment and Channel actions, and uses `.openagentpack/state.json` as the remote-resource ledger.

Fresh initialization leaves Agent resource references unset. Each generated resource example has a bilingual README explaining how to configure and enable it. Build skips `_examples/` directories during resource discovery, so these examples do not enter YAML, Workbench declarations, or remote Publish actions. Copy a resource outside `_examples/` and add its Agent reference when needed. Example files remain part of local source-version snapshots; do not put real secrets in them.

Build externalizes literal `secret_value` and `access_token` fields in Agent-local/shared `vault.json` into the selected project's root `.env`, and writes `${AGENTS_VAULT_...}` references back to JSON. Existing references and `.env` entries are preserved; conflicting names receive suffixes. Preview/dry-run are read-only and hide secret values. `.env` has owner-only permissions (`0600`) and is excluded from local versions; it is not encrypted or automatically Git-ignored. Publish and Workbench read this project-root `.env` as a fallback to inherited environment variables, independently of the caller's current directory.

Workbench edits or removes existing Agent, Environment, Skill, Vault, Memory Store, and File declarations directly in their directory source files; it provides no create action. Agent instructions and Skill Markdown are editable, external ownership fields and File paths remain read-only, referenced declarations cannot be removed, and every save requires a server-generated redacted Diff. Saving invalidates Build. The Changes tab separates Build, Plan Publish, and Publish; it never builds or publishes implicitly.

`project version enable|disable|status|list|preview|restore` and Workbench share one switch and one store under `.openagentpack/versions/project`. Versions contain the complete authored source tree, file modes, text, binary files, and local Skill content through immutable manifests and content-addressed blobs. They never contain or restore `.openagentpack/state.json`. Restore is a forward working-tree write: it does not move history, invoke Publish, or change remote State.

Build, Publish, declaration writes, and Restore share a cross-process mutation lock. Workbench additionally exposes in-process mutation state over SSE so every browser window disables saves while Publish is active. External edits remain possible; Publish uses its frozen Build/source snapshot and reports when the working tree changed during the remote run.

## `agents validate`

Validate the whole configuration file offline — checks YAML shape and field validity without making API calls. This command does not accept `--provider`; use `plan --provider <name> --refresh false` when you want to inspect one provider's projected changes without contacting remote APIs.

## `agents plan`

Show what changes would be applied. Refreshes remote state and detects drift by default.

| Option | Description |
|--------|-------------|
| `--provider <name>` | Target provider (`all` by default). |
| `--refresh <bool>` | Refresh state from remote before planning (default `true`). |
| `--refresh-only` | Refresh state and show drift without planning remote mutations. |
| `--json` | Output as JSON. |

## `agents apply`

Apply the planned changes to create / update / delete resources.

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt. |
| `--provider <name>` | Target provider (`all` by default). |
| `--refresh <bool>` | Refresh state from remote before planning (default `true`). |
| `--refresh-only` | Refresh state without mutating remote resources. |
| `--concurrency <n>` | Max independent resources to apply in parallel (default 6, max 10). |

## `agents destroy`

Destroy all managed resources.

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt. |
| `--cascade` | Auto-delete dependent resources (e.g. sessions referencing an environment). |

## `agents sync`

Export a provider's remote configuration into a local `agents.yaml`.

| Option | Description |
|--------|-------------|
| `--provider <name>` | Source provider to sync from. |
| `-o, --out <path>` | Output file (default `agents.synced.yaml`). |
| `--force` | Overwrite the output file if it exists. |
| `--skip-missing-files` | Do not prompt for remote files that cannot be downloaded; omit them from the synced output. |

## `agents migrate`

Merge synced resources into the project `agents.yaml` (incremental, skips existing).

| Option | Description |
|--------|-------------|
| `--from <path>` | Source synced file (default `agents.synced.yaml`). |
| `--to <path>` | Target file (default `agents.yaml`). |

## `agents state`

Inspect and manage the state file.

| Subcommand | Description |
|------------|-------------|
| `state list` | List all resources in state. |
| `state show <address>` | Show details of a resource in state. |
| `state rm <address>` | Remove a resource from state without destroying it remotely. |
| `state import <address> <remote-id>` | Import an existing remote resource into state. |

`state import` accepts `--resource-version <number>` for versioned resources (agents).

## `agents session`

Manage runtime agent sessions.

| Subcommand | Description |
|------------|-------------|
| `session create [agent-name]` | Create a new session. |
| `session list` | List sessions from the provider. |
| `session get <session-id>` | Get details of a session. |
| `session run <prompt-or-agent> [prompt]` | Create a session, send a message, and poll until the response completes. |
| `session send <session-id> <message>` | Send a message to an existing session and poll until the response completes. |
| `session events <session-id>` | List event history for a session. |
| `session delete <session-id>` | Delete a session. |

`session create` / `session run` accept `--agent`, `--identity-id`, `--environment`, `--vault`, `--memory-stores`, `--title`, and `--provider`. Forward Sessions resolve the declared logical `defaults.identity`; `--identity-id` overrides it with an existing provider id for one invocation. `session run` and `session send` use polling by default and accept `--stream` to opt into SSE streaming, plus `--json` for JSON output. `session list` accepts `--agent` and `--all`; `session events` accepts `--limit`, `--all`, `--json`.

## `agents deployment`

Manage scheduled / triggered deployments.

| Subcommand | Description |
|------------|-------------|
| `deployment list` | List deployments tracked in state. |
| `deployment list --remote --provider <provider>` | List deployments from a native provider API; supports status, agent, archive, limit, and pagination filters. |
| `deployment get <name>` | Show a deployment's status and resolved bindings. |
| `deployment pause <name>` | Pause scheduled runs for a native deployment. |
| `deployment unpause <name>` | Resume a paused native deployment. |
| `deployment run <name>` | Trigger a deployment run (native on Bailian/Qoder/Claude, emulated as a session on Volcengine Ark). |

## `agents memory-store`

Manage persistent stores directly. Store creation through `agents apply` remains
the recommended declarative workflow.

| Command | Description |
|---------|-------------|
| `create <name>` | Create a store (`--description`). |
| `list` | List stores (`--limit`, `--cursor`, `--include-archived`). |
| `get <store-id>` | Retrieve a store. |
| `update <store-id>` | Update `--name` and/or `--description`. |
| `archive <store-id>` | Archive a store (Qoder/Claude). |
| `delete <store-id>` | Permanently delete a store and its memories. |

## `agents memory`

Manage individual text memories. Content can be passed with `--content` or
`--content-file`. Portable paths are relative; adapters handle wire-format differences.

| Command | Description |
|---------|-------------|
| `create <store-id> <path>` | Create one memory. |
| `batch-create <store-id> <json-file>` | Ark batch create; supports `--on-conflict overwrite\|fail`. |
| `list <store-id>` | List memories; supports pagination, prefix/depth and `--full`. |
| `get <store-id> <memory-id>` | Retrieve full content. |
| `update <store-id> <memory-id>` | Update content/path; `--expected-sha256` enables optimistic concurrency where supported. |
| `delete <store-id> <memory-id>` | Delete one memory. |
| `version list|get|redact` | Immutable history operations (Qoder/Claude). |

## `agents models`

| Subcommand | Description |
|------------|-------------|
| `models list` | List models available on the configured provider(s). Accepts `--json`. |

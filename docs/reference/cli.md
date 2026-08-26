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

The Workbench Resources tab edits or removes declarations already present in `agents.yaml`; it has no create action. Agent, Environment, Skill, Vault, Memory Store, and File changes require a server-generated YAML Diff before save. Local file-backed content and external ownership fields remain read-only, and referenced declarations cannot be removed. Saving writes only `agents.yaml`, refreshes the project, and automatically opens a new project runtime Plan. Apply remains a separate confirmation.

Workbench does not initialize version storage automatically. The user must explicitly enable versions in the Versions tab or through `agents version enable`; that action creates a baseline when needed and updates the shared switch. `store.json` contains only the switch and head, immutable linked metadata lives under `entries/`, and complete YAML lives in content-addressed `blobs/<sha256>.yaml` files. Before every Agent- or project-scoped Apply, Workbench versions changed YAML; unchanged YAML does not create an empty version. Restore validates the selected full version ID and blob hash, then writes historical YAML back as a forward working-tree change without changing version history. `agents.state.json` and referenced files are never included. Apply, declaration writes, version writes, and restore remain mutually exclusive, while historical browsing is available during Apply.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Project configuration to open (default `agents.yaml`). |
| `--agent <id>` | Agent to preview (required for direct Preview when multiple Agents are declared). |
| `--port <n>` | Port to serve on (default `4848`). |
| `--no-open` | Do not open a browser automatically. |

Workbench Changes reviews a project runtime Plan before Apply. The plan covers declared runtime resources, including transitive dependencies, but excludes Deployment and Channel actions. The existing Agent-scoped Plan/Apply protocol remains available to Session Preview callers. Apply uses a single-use, ten-minute Plan token, requires explicit confirmation for destructive actions, replans immediately before execution, and rejects stale or newly changed plans. Temporary attachments are uploaded for Sessions without modifying YAML or state and remain recorded locally until their explicit remote deletion succeeds.

## `agents workbench`

Launch the same local Server and open the `agents.yaml` project Workbench without creating a Session. The command shares project identity, process reuse, port handling, and configuration watching with `agents playground`.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Project configuration to open (default `agents.yaml`). |
| `--port <n>` | Port to serve on (default `4848`). |
| `--no-open` | Do not open a browser automatically. |

## `agents version`

Manage Git-independent local snapshot history for the selected `agents.yaml`. CLI Apply-time snapshots are disabled until versioning is enabled.

All version subcommands accept `--file <path>` to select the project configuration. They intentionally do not define a command-level `-f` alias, so the option is not confused with force.

| Subcommand | Description |
|------------|-------------|
| `version enable` | Initialize the local store, enable automatic versions, and create a baseline snapshot when needed. |
| `version disable` | Disable automatic versions without deleting snapshots or working-tree changes. |
| `version status` | Show the opt-in, store location, current version, YAML status, and operation blockers. |
| `version list` | List local snapshots; supports `--limit`, `--cursor`, and `--json`. |
| `version preview <full-id>` | Show a redacted Git-style Diff and restore diagnostics for a full version ID. |
| `version restore <full-id>` | Atomically write historical YAML to the working tree; accepts `--yes` and `--json`. |

The shared CLI/Workbench switch lives in the YAML-local `store.json`. Each project directory has independent history. Either host can enable or disable it, and there is no manual `version create` command.

When enabled, `agents apply` validates YAML and the local store before remote mutations and records dirty YAML as `Apply agents.yaml` only after all actions succeed. A no-op Apply can record a still-dirty YAML, while cancelled, failed, incomplete, or `--refresh-only` runs do not create a version. An unchanged YAML does not create an empty snapshot. If YAML or the current version changes during Apply, the remote run may already have completed but the snapshot is rejected; resolve the local conflict and rerun Apply to retry it.

`store.json` contains only the shared switch and head. Immutable linked metadata under `entries/` points to full content-addressed YAML in `blobs/`, which is verified before restore. Plaintext credentials, invalid YAML, concurrent store writes, and stale version/source identities block creation or restore. `agents.state.json` and referenced files are never restored.

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

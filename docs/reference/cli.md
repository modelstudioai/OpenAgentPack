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

Create a new `agents.yaml` template via an interactive wizard (provider selection + agent name). Appends `agents.state.json` and `.env` to `.gitignore`.

Pass a directory to scaffold a local Aone-ready project repository:

```bash
agents init --git my-agent --provider bailian --agent-name assistant
```

For a directory that already contains `agents.yaml`, `agents init --git .` upgrades the project in place: it preserves the declaration and existing README/Aone workflows, creates or preserves `agents.state.json`, removes that file from `.gitignore`, merges missing package and environment-example entries, and initializes Git only when `.git` is absent. For a new or empty directory, repository mode creates `agents.yaml`, an external instructions file, `.env.example`, `.gitignore`, `package.json`, `README.md`, `agents.state.json`, `.aoneci/openagentpack-check.yml`, and `.aoneci/openagentpack.yml`, then initializes a local Git repository on `main`. The check pipeline validates, plans, and uploads the plan artifact without applying; bind it to Codeup merge-request events in Aone. The main-push pipeline repeats validation/plan, applies through the non-interactive `--ci` policy, and commits updated state back to `main`. CI policy blocks deletes and remote drift for a separate approved workflow. Init itself does not create a Codeup remote, commit, push, or apply cloud changes. Aone secrets, checkout write permission, serial execution, merge-request binding, and approval gates are platform-side settings.

| Option | Description |
|--------|-------------|
| `--provider <provider>` | Configure `bailian`, `claude`, `qoder`, `ark`, or `all` without prompting. |
| `--agent-name <name>` | Set the first Agent name without prompting. |
| `--git <directory>` | Create an Aone-ready project in a new/empty directory, or add Git CI scaffolding when the directory already contains `agents.yaml`. Without it, `agents init` keeps the original current-directory behavior. |

## `agents playground`

Launch the local web UI and open an `agents.yaml` Agent directly in Preview.

Playground opens the project selected by `-f`, watches the YAML and its local dependencies, and uses each Agent's declared Provider. A single Agent is selected automatically. For multiple Agents, pass `--agent <id>`; otherwise the Workbench opens for selection. Missing or invalid projects also open the diagnostic Workbench.

The Workbench Resources tab edits or removes declarations already present in `agents.yaml`; it has no create action. Agent, Environment, Skill, Vault, Memory Store, and File changes require a server-generated YAML Diff before save. Local file-backed content and external ownership fields remain read-only, and referenced declarations cannot be removed. Saving writes only `agents.yaml`, refreshes the project, and automatically opens a new project runtime Plan. Apply remains a separate confirmation.

Workbench uses the nearest parent Git repository containing `agents.yaml`. If none exists, the UI automatically initializes `main` in the configuration directory and creates an `Initialize agents.yaml` commit. Before every Agent- or project-scoped Apply, Workbench commits the current `agents.yaml` when it differs from HEAD; an already-versioned YAML reuses HEAD without creating an empty commit. Automatic versioning commits only `agents.yaml` without changing other staged, modified, or untracked files, and a Git blocker prevents the remote Apply. Restore reads a full-SHA commit reachable from the current HEAD and writes that historical YAML back as an uncommitted forward working-tree change; it does not reset HEAD or restore `agents.state.json` and referenced files. Workbench does not push, fetch, pull, switch branches, create tags, or configure Git identity. Apply and Workbench YAML/Git writes are mutually exclusive, while historical browsing remains available during Apply.

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

Manage local Git history for the selected `agents.yaml`. CLI Apply-time commits are disabled by default even when the project already belongs to a Git repository.

All version subcommands accept `--file <path>` to select the project configuration. They intentionally do not define a command-level `-f` alias, so the option is not confused with force.

| Subcommand | Description |
|------------|-------------|
| `version enable` | Discover the nearest parent repository, or initialize `main` in the YAML directory, then record a checkout-local opt-in and create a baseline commit when needed. |
| `version disable` | Remove the opt-in for this YAML without deleting the repository, commits, or working-tree changes. |
| `version status` | Show the opt-in, repository, branch, HEAD, YAML status, and operation blockers. |
| `version list` | List current-branch commits that changed this YAML; supports `--limit`, `--cursor`, and `--json`. |
| `version preview <full-sha>` | Show a redacted Git-style Diff and restore diagnostics for a reachable full commit SHA. |
| `version restore <full-sha>` | Atomically write historical YAML to the working tree; accepts `--yes` and `--json`. |

The shared CLI/Workbench switch is stored as a marker in the selected worktree's private Git directory and keyed by the YAML's repository-relative path. It is isolated between linked worktrees and does not travel through clone or push, so enable it separately in each checkout that should use automatic versions. Either host can enable or disable it; Workbench only enables it automatically when creating a new repository. There is no manual `version create` command.

When enabled, `agents apply` validates Git and YAML before remote mutations and commits dirty YAML as `Apply agents.yaml` only after all actions succeed. A no-op Apply can record a still-dirty YAML, while cancelled, failed, incomplete, or `--refresh-only` runs do not commit. An unchanged YAML reuses HEAD without an empty commit. If YAML, HEAD, or the branch changes during Apply, the remote run may already have completed but the commit is rejected; fix the Git state and rerun Apply to retry it.

Version commits use a temporary index and contain only `agents.yaml`, leaving unrelated staged, modified, and untracked files unchanged. Plaintext credentials, staged/conflicted YAML, detached HEAD, missing Git identity, and in-progress merge/rebase operations block commits. Restore does not move HEAD and never restores `agents.state.json` or referenced files. These commands do not push, fetch, pull, switch branches, or create tags.

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
| `--ci` | Run non-interactively, but block delete actions and remote/combined drift. Cannot be combined with `--yes` or `--refresh false`. |
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

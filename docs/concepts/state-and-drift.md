# State and drift

At any moment there are three descriptions of your agents. OpenAgentPack reconciles them on every command.

## The three sources of truth

1. **Config** — your `agents.yaml`. The desired state and the single source of truth.
2. **State** — a local state file (`agents.state.json`) recording what OpenAgentPack has created, the content hash of each resource, and the mapping from declared resources to remote IDs.
3. **Remote** — what actually exists on the provider.

```text
config ──┐
         ├──▶ diff ──▶ plan (create / update / delete)
state  ──┘
```

`plan` computes the difference; `apply` makes remote match config and updates state.

## How a change is classified

For each declared resource OpenAgentPack computes a content hash and compares it against the hash recorded in state. The resulting action is one of `create`, `update`, `delete`, or `no-op`:

- **In config, not in state** → `create`.
- **In config and state, hash changed** → `update`.
- **In state, not in config** → `delete`.
- **In config and state, hash unchanged** → `no-op` (skipped — no API call).

This content-hash diffing is what makes runs incremental: unchanged resources are never touched.

## Drift

Remote state can drift from your declaration — someone edits an agent in the provider console, for example. Each state record carries a drift status of `in_sync`, `drifted`, `missing`, or `unchecked`, and each planned action carries a drift kind of `none`, `local`, `remote`, or `both`.

By default `plan` and `apply` refresh from remote first and surface any drift. Because config is the source of truth, `apply` reconciles remote back to what the YAML declares.

Control refresh behavior with flags:

- `--refresh=false` — skip the remote refresh and plan against local state only.
- `--refresh-only` — refresh state and report drift **without** making remote mutations.

## Adopting existing remote resources

`plan`/`apply` push config **to** the provider. Two commands go the other way, for adopting resources that already exist remotely:

- `agents sync` — export a provider's remote configuration into a local YAML.
- `agents migrate` — merge synced resources into your `agents.yaml`, incrementally, skipping ones you already declare.

You can also adopt a single existing remote resource into state without recreating it:

```bash
agents state import <address> <remote-id>
```

For the deep mechanism — content hashing, conflict-vs-referenced error seams, and the executor — see [How it works](../architecture/how-it-works.md).

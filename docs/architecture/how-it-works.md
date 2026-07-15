# How It Works

**English** | [简体中文](./how-it-works.zh-CN.md)

OpenAgentPack applies the mental model of infrastructure-as-code tools like Terraform to cloud AI agents. This document explains the pieces behind `plan` and `apply`.

## The three sources of truth

At any moment there are three descriptions of your agents:

1. **Config** — your `agents.yaml`. This is the desired state and the single source of truth.
2. **State** — a local state file recording what OpenAgentPack has created and the content hash of each resource. It maps declared resources to their remote IDs.
3. **Remote** — what actually exists on the provider.

Every command reconciles these three. `plan` computes the difference; `apply` makes remote match config and updates state.

## Planning

```text
config ──┐
         ├──▶ diff ──▶ plan (create / update / delete)
state  ──┘
```

For each declared resource OpenAgentPack computes a content hash and compares it against the hash in state:

- **In config, not in state** → **create**.
- **In config and state, hash changed** → **update**.
- **In state, not in config** → **delete**.
- **In config and state, hash unchanged** → **no-op** (skipped — no API call).

This content-hash diffing is what makes runs incremental: unchanged resources are never touched.

## Dependency ordering

Resources form a dependency graph — an agent depends on its environment, skills, and vault; a coordinator depends on the agents it orchestrates. OpenAgentPack topologically sorts the graph so dependencies are created before dependents.

If a resource fails to apply, its dependents are **skipped** rather than attempted against missing prerequisites, so a run never leaves a half-built agent pointing at an environment that failed to create.

## Drift detection and recovery

Remote state can drift from your declaration — someone edits an agent in the provider console, for example. By default `plan` and `apply` refresh from remote first and surface any drift. Because config is the source of truth, `apply` reconciles remote back to what the YAML declares.

Control refresh behavior with flags:

- `--refresh=false` — skip the remote refresh and plan against local state only.
- `--refresh-only` — refresh state and report drift **without** making remote mutations.

## Sync and migrate

`plan`/`apply` push config **to** the provider. Two commands go the other way, for adopting resources that already exist remotely:

- `agents sync` — export a provider's remote configuration into a local YAML (currently vaults).
- `agents migrate` — merge synced resources into your `agents.yaml`, incrementally, skipping ones you already declare.

You can also adopt a single existing remote resource into state without recreating it:

```bash
agents state import <address> <remote-id>
```

## Sessions vs. resources

Resources (agents, environments, skills…) are **infrastructure** — long-lived, managed by `plan`/`apply`. A **session** is a **runtime** conversation started from an agent. Sessions are managed separately with `agents session` and are not part of the plan/apply lifecycle.

Deployments sit between the two: they are declared as resources but produce runs. On Claude they schedule server-side; on Bailian, Qoder, and Volcengine Ark a `deployment run` expands into a session.

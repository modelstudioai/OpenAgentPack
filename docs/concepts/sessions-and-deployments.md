# Sessions and deployments

OpenAgentPack separates **infrastructure** from **runtime**. Resources are long-lived and managed by `plan`/`apply`; sessions are short-lived runtime conversations that you start from a managed agent.

## Resources vs. sessions

- **Resources** (agents, environments, skills, vaults, deployments) are infrastructure. They are declared in `agents.yaml`, tracked in state, and reconciled by `plan`/`apply`. They persist until you `destroy` them.
- A **session** is a runtime conversation started from an agent. A session binds an agent + an environment + vaults + memory stores + files into one runnable unit. Sessions are managed separately with `agents session` and are **not** part of the plan/apply lifecycle.

Creating a session does not change your config or your state; deleting a session does not affect managed resources.

## Deployments sit between the two

A **deployment** is declared as a resource (so it lives in `agents.yaml` and is managed by `plan`/`apply`) but it produces runs. A deployment bundles:

- an `agent` (and optional `agent_version`)
- optional bindings: `environment`, `vaults`, `memory_stores`, `resources` (files, memory stores, or GitHub repos)
- `initial_events` — the prompt that seeds each run (a user message, a system message, or a `user.define_outcome` outcome rubric)
- an optional `schedule` (a 5-field cron expression + timezone)

How a deployment *runs* depends on the provider's capability tier:

| Provider | Deployment tier | What `agents deployment run` does |
|----------|:--------------:|------------------------------------|
| Claude | native | schedules server-side through the deployments API |
| Qoder | native | creates a deployment run and associated session |
| Bailian, Ark | emulated | expands into a one-shot session at run time |

On the emulated providers, scheduling and outcome rubrics are **not** enforced server-side — use external cron/CI for always-on or scheduled runs.

## The lifecycle in one picture

```text
agents.yaml ──plan/apply──▶ managed resources (agent, environment, …)
                               │
                               └─session create/run──▶ runtime session
                               └─deployment run──────▶ runtime session (emulated) or scheduled run (native)
```

Next: [Run sessions](../guides/run-sessions.md) and [Manage deployments](../guides/manage-deployments.md).

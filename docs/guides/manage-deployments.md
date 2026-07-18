# Manage deployments

A **deployment** is a declared resource that produces runs. It bundles an agent with runtime bindings, initial events, and an optional schedule.

## Declare a deployment

```yaml
deployments:
  daily-report:
    agent: reporter
    description: "Scheduled daily report (server-side cron + outcome grading)"
    schedule:
      expression: "0 9 * * *"
      timezone: UTC
    initial_events:
      - type: user.message
        content: "Summarize yesterday's commits and generate the daily report."
      - type: user.define_outcome
        description: "Daily report quality gate"
        rubric: "Must include an executive summary and at least three key metrics."
        max_iterations: 3
    resources:
      - type: file
        source: ./data/report-template.md
        mount_path: /data/report-template.md
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `agent` | yes | Agent name to run. |
| `agent_version` | no | Pin a versioned agent. |
| `environment` | no | Override the agent's environment. |
| `vaults` | no | Vault bindings. |
| `memory_stores` | no | Memory store bindings. |
| `resources` | no | `file`, `memory_store`, or `github_repository` resources to mount. |
| `initial_events` | yes | 1–50 events that seed each run. |
| `schedule` | no | 5-field cron `expression` + `timezone`. |

## Initial event types

| Type | Purpose |
|------|---------|
| `user.message` | The user prompt that starts the run. |
| `system.message` | A system instruction prepended to the run. |
| `user.define_outcome` | An outcome rubric the run is graded against (`description`, `rubric`/`rubric_file`, `max_iterations` 1–20). |

## Resource mounts

| Resource type | Key fields |
|---------------|------------|
| `file` | `source` or `file_id`, `mount_path` |
| `memory_store` | `memory_store`, `access` (`read_write` \| `read_only`), `instructions` |
| `github_repository` | `url`, `checkout` (`branch`/`commit`), `mount_path`, `authorization_token` |

A `file` with a local `source` is uploaded during `apply` (Files API) and the returned `file_id` is stored in state; at run time it is mounted at `mount_path`.

## Run a deployment

```bash
agents deployment list                  # deployments tracked in state
agents deployment get <name>            # status + resolved bindings
agents deployment run <name>            # trigger a run
```

## Native vs. emulated

| Provider | Deployment tier | What `deployment run` does |
|----------|:--------------:|----------------------------|
| Claude | native | schedules server-side through the deployments API |
| Qoder | native | creates a deployment run and associated session |
| Bailian, Ark | emulated | expands into a one-shot session at run time |

On the emulated providers, scheduling and outcome rubrics are **not** enforced server-side — use external cron/CI for always-on or scheduled runs.

## Examples

- Native deployment + outcome rubric: [`examples/claude/deployment/`](../../examples/claude/deployment/)
- Native deployment + memory store: [`examples/qoder/deployment/`](../../examples/qoder/deployment/)
- Emulated deployment + file resources: [`examples/bailian/deployment/`](../../examples/bailian/deployment/) and [`examples/ark/deployment/`](../../examples/ark/deployment/)

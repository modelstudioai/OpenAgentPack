# Run sessions

A **session** is a runtime conversation started from a managed agent. Sessions are not part of the `plan`/`apply` lifecycle — creating or deleting one does not change your config or state.

## Prerequisites

`agents apply` first, so the agent and its environment exist on the provider. Then:

## Create and run in one step

```bash
agents session run "Summarize the repo structure" --agent assistant
```

`session run` creates a session, sends the prompt, and streams the response. When only one agent is configured, `--agent` is auto-detected.

Options:

| Option | Description |
|--------|-------------|
| `--agent <name>` | Agent to run (auto-detected with one agent). |
| `--environment <name>` | Override the agent's declared environment. |
| `--vault <name>` | Override the agent's declared vault. |
| `--memory-stores <names>` | Override the agent's declared memory stores (comma-separated). |
| `--title <title>` | Session title. |
| `--provider <name>` | Target provider (required for multi-provider agents). |
| `--json` | Output events as JSONL. |
| `--no-stream` | Use polling instead of SSE streaming. |

## Continue an existing session

```bash
agents session send <session-id> "Follow up: list the entry points"
```

## Inspect sessions

```bash
agents session list                       # list sessions
agents session list --agent assistant     # filter by agent
agents session get <session-id>           # session detail
agents session events <session-id>        # event history (--json, --limit, --all)
agents session delete <session-id>
```

## What a session binds

A session binds an agent + an environment + vaults + memory stores + files into one runnable unit. The bindings are resolved from the agent declaration and the state file; `session create` lets you override `--environment`, `--vault`, and `--memory-stores` at run time.

## Programmatic usage

```ts
import {
  resolveProjectConfig,
  createSessionForAgent,
  startSessionRun,
} from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const session = await createSessionForAgent(config, { agentName: "assistant" });
for await (const event of startSessionRun(config, session.id, "Hello")) {
  console.log(event);
}
```

See the [SDK reference](../reference/sdk.md) for the full session API.

## Examples

- [`examples/runtime/run-session.ts`](../../examples/runtime/run-session.ts) — create a session and stream SSE by hand.
- [`examples/runtime/run-session-complex.ts`](../../examples/runtime/run-session-complex.ts) — tool calls and streaming events.

# Run sessions

A **session** is a runtime conversation started from a managed agent. Sessions are not part of the `plan`/`apply` lifecycle — creating or deleting one does not change your config or state.

## Prerequisites

`agents apply` first, so the agent and its environment exist on the provider. Then:

## Create and run in one step

```bash
agents session run "Summarize the repo structure" --agent assistant
```

`session run` creates a session, sends the prompt, and polls until the response completes. Pass `--stream` to receive live events over SSE. When only one agent is configured, `--agent` is auto-detected. For a Qoder agent with `delivery.qoder.type: forward`, Identity is optional: without one OpenCMA looks up the enabled Identity whose `external_id` is `__qca_admin_identity__` and sends its real `idn_...` id. Configure `defaults.session.qoder.identity_id` or pass `--identity-id` to select an existing business Identity. OpenCMA never creates or updates Identity resources implicitly.

Options:

| Option | Description |
|--------|-------------|
| `--agent <name>` | Agent to run (auto-detected with one agent). |
| `--identity-id <id>` | Override the configured Qoder Forward Identity for this Session. |
| `--environment <name>` | Override the agent's declared environment. |
| `--vault <name>` | Override the agent's declared vault. |
| `--memory-stores <names>` | Override the agent's declared memory stores (comma-separated). |
| `--title <title>` | Session title. |
| `--provider <name>` | Target provider (required for multi-provider agents). |
| `--json` | Output events as JSONL. |
| `--stream` | Use SSE streaming instead of the default polling mode. |

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

A Managed Session binds an Agent + environment + vaults + memory stores + files. A Qoder Forward Session binds a Template + Identity; the Template already owns its environment, tunnel, vault, and MCP configuration. `session create` lets callers override the relevant runtime bindings.

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

# Run sessions

A **session** is a runtime conversation started from a managed agent. Sessions are not part of the `plan`/`apply` lifecycle — creating or deleting one does not change your config or state.

## Prerequisites

`agents apply` first, so the agent and its environment exist on the provider. Then:

## Create and run in one step

```bash
agents session run "Summarize the repo structure" --agent assistant
```

`session run` creates a session, sends the prompt, and polls until the response completes. Pass `--stream` to receive live events over SSE. When only one agent is configured, `--agent` is auto-detected. A Qoder agent with `delivery.qoder.type: forward` requires a declared Identity selected through `defaults.identity`; `agents apply` creates or resolves it before sessions run. Pass `--identity-id` only to override the resolved default with an existing provider Identity for one invocation.

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

A Managed Session binds an Agent + environment + vaults + memory stores + files + declared resources. A Qoder Forward Session binds a Template + Identity; the Template already owns its environment, tunnel, vault, and MCP configuration. `session create` lets callers override the relevant runtime bindings.

To mount a private GitHub repository in every managed Session, declare a provider-neutral resource on the Agent. Qoder and Claude receive their respective API wire shapes from the same configuration:

```yaml
agents:
  assistant:
    # model, instructions, environment, ...
    resources:
      - type: github_repository
        url: ${GITHUB_REPOSITORY_URL}
        authorization_token: ${GITHUB_TOKEN}
        checkout: { branch: main }
```

Store both variables in `.env` (which is gitignored). The token must be able to read the repository. `checkout` and `mount_path` are optional in the portable declaration. For Qoder, OpenAgentPack always sends a path under `/data`: when omitted it derives `/data/workspace/<repo-name>` from `url`; an explicit Qoder `mount_path` must start with `/data/`. This is required for Qoder to materialize the repository in the Session environment. Other providers retain their own path semantics.

Provider mount roots are fixed and OpenAgentPack applies the same policy to wire requests and prompt file hints:

| Provider | Required mount root | Default GitHub repository path |
| --- | --- | --- |
| Qoder | `/data` | `/data/workspace/<repo-name>` |
| Claude | `/workspace` | `/workspace/<repo-name>` |
| Bailian | `/mnt` | GitHub Session resources unsupported |
| Ark | `/mnt` | GitHub Session resources unsupported |

An explicit absolute path must already use the target provider's root and is passed through unchanged; an absolute path under another root is a validation error. A relative uploaded-file path is resolved under the provider root. Portable configurations should normally omit repository `mount_path` and let the provider adapter derive it.

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

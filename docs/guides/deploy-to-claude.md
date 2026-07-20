# Deploy to Claude

Claude is the provider with the broadest native capability coverage, including server-side deployments and multi-agent coordination.

## Provider configuration

```yaml
providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
    beta: "..."          # optional; sent as the anthropic-beta header
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `api_key` | yes | Anthropic API key. Resolve from `.env` with `${ANTHROPIC_API_KEY}`. |
| `beta` | no | Optional beta header value. |

## Capabilities

| Feature | Tier |
|---------|:----:|
| Environment, Vault, Skill, Agent, MCP Server, Multi-Agent, Deployment, Session | native |
| Memory Store | native (beta) |

Memory stores require the Claude `agent-memory-2026-07-22` beta, enabled by the adapter by default.

## Minimal agent

```yaml
version: "1"

providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}

defaults:
  provider: claude

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "General-purpose coding assistant"
    model: claude-sonnet-4-6
    instructions: |
      You are a helpful coding assistant.
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

## What Claude uniquely supports

- **Multi-agent** — declare a `coordinator` agent that orchestrates others. See [`examples/claude/multiagent/`](../../examples/claude/multiagent/).
- **Native deployments** — scheduled server-side with outcome rubrics. See [Manage deployments](./manage-deployments.md) and [`examples/claude/deployment/`](../../examples/claude/deployment/).

## Next steps

- [Use skills](./use-skills.md)
- [Use MCP and vaults](./use-mcp-and-vaults.md)
- Full Claude config: [`examples/claude/full/`](../../examples/claude/full/)

# Deploy to Qoder

Qoder is a managed-agent platform with native **memory stores** and **deployments**, but no multi-agent primitive.

## Provider configuration

```yaml
providers:
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"   # optional; this is the default
```

| Field | Required | Default | Description |
|-------|:--------:|---------|-------------|
| `api_key` | yes | — | Qoder personal access token. Resolve from `.env` with `${QODER_PAT}`. |
| `gateway` | no | `https://api.qoder.com/api/v1/cloud` | Qoder cloud gateway base URL. |

## Capabilities

| Feature | Tier |
|---------|:----:|
| Environment, Vault, Skill, Agent, MCP Server, Memory Store, Deployment, Session | native |
| Multi-Agent | unsupported |

A `deployment run` on Qoder creates a native Deployment Run and associated Session. Cron schedules run server-side.

## Tool naming

Qoder uses PascalCase tool names natively (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Write`, `Edit`, `Bash`). Write tools **lowercase** in config and OpenAgentPack converts them automatically when applying to Qoder — this keeps the same config portable to Bailian, Claude, and Volcengine Ark.

| Function | Config (lowercase) | Qoder native |
|----------|--------------------|--------------|
| Read file | `read` | `Read` |
| Find files | `glob` | `Glob` |
| Search content | `grep` | `Grep` |
| Fetch web page | `web_fetch` | `WebFetch` |
| Web search | `web_search` | `WebSearch` |
| Write file | `write` | `Write` |
| Edit file | `edit` | `Edit` |
| Shell | `bash` | `Bash` |

## Minimal agent

```yaml
version: "1"

providers:
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"

defaults:
  provider: qoder

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "General-purpose coding assistant"
    model: ultimate
    instructions: |
      You are a helpful coding assistant.
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

## What Qoder uniquely supports

- **Memory stores** — persistent context for an agent. See [`examples/qoder/with-memory/`](../../examples/qoder/with-memory/).

## Next steps

- [Multi-provider](./multi-provider.md) — deploy the same agent to both Claude and Qoder.
- Full Qoder config: [`examples/qoder/full/`](../../examples/qoder/full/)

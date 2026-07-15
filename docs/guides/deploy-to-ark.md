# Deploy to Ark

Ark (Volcengine Managed Agents) supports both **memory stores** and **multi-agent** coordination, with emulated deployments.

## Provider configuration

```yaml
providers:
  ark:
    api_key: ${ARK_API_KEY}
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `api_key` | yes | Ark API key. Resolve from `.env` with `${ARK_API_KEY}`. |

## Capabilities

| Feature | Tier |
|---------|:----:|
| Environment, Vault, Skill, Agent, MCP Server, Memory Store, Multi-Agent, Session | native |
| Deployment | emulated |

- Skills are uploaded as a single zip (create + get + attach only — no update/delete).
- `deployment run` expands into a one-shot session; scheduling/outcome rubrics are not enforced server-side.

## Minimal agent

```yaml
version: "1"

providers:
  ark:
    api_key: ${ARK_API_KEY}

defaults:
  provider: ark

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "General-purpose coding assistant"
    model: doubao-seed-2-1-pro-260628
    instructions: |
      You are a helpful coding assistant.
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

## What Ark uniquely supports

- **Memory stores** — persistent context for an agent. See the `memory_store` resources in [`examples/ark/full/`](../../examples/ark/full/).
- **Multi-agent** — declare a `coordinator` agent. See [`examples/ark/multiagent/`](../../examples/ark/multiagent/).
- **Files API** — upload local files. See [`examples/ark/with-files/`](../../examples/ark/with-files/).

## Next steps

- Full Ark config (memory store + dual environments): [`examples/ark/full/`](../../examples/ark/full/)

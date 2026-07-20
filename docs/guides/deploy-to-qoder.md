# Deploy to Qoder

Qoder is a managed-agent platform with native **memory stores** and **deployments**, but no multi-agent primitive.

## Provider configuration

```yaml
providers:
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"   # optional; this is the default
    forward_gateway: "https://api.qoder.com/api/v1/forward" # optional; derived from gateway by default
```

| Field | Required | Default | Description |
|-------|:--------:|---------|-------------|
| `api_key` | yes | — | Qoder personal access token. Resolve from `.env` with `${QODER_PAT}`. |
| `gateway` | no | `https://api.qoder.com/api/v1/cloud` | Qoder cloud gateway base URL. |
| `forward_gateway` | no | derived from `gateway` | Qoder Forward gateway used for Template lifecycle requests. |

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
- **Forward Templates** — declaratively materialize an `agents.*` declaration as a reusable Forward baseline:

```yaml
agents:
  forward-assistant:
    model: auto
    instructions: You are a helpful assistant.
    environment: byoc
    tunnel: private-network
    vault: mcp-credentials
    delivery:
      qoder:
        type: forward
```

`agents plan/apply/destroy` then manage a Qoder Forward Template (`tmpl_...`) instead of a Managed Agent
(`agent_...`). The default remains Managed Agent delivery when `delivery` is omitted.

Identity is optional for local Forward Session testing. If omitted, OpenCMA finds the enabled Qoder Identity whose
`external_id` is `__qca_admin_identity__`, then sends its real `idn_...` id to the Session API. To run as a specific
user—or when the reserved Identity is unavailable—configure an existing Identity explicitly:

```yaml
defaults:
  provider: qoder
  session:
    qoder:
      identity_id: idn_xxx
```

Then use the same session command to test a Forward-delivered agent:

```bash
agents session run "Hello" --agent forward-assistant
```

The CLI resolves the applied Template and optional configured Identity, creates a Forward Session, and routes create, send,
stream, get, and archive operations through the Forward gateway. It never creates or updates an Identity as a side effect
of starting a Session. Use `--identity-id idn_xxx` to override the YAML default for one invocation. Managed sessions keep
using the Cloud gateway.

Production messaging delivery is a separate Forward Channel concern. An IM Channel explicitly binds a business Identity
and Template; do not treat the CLI's local testing Identity as an end-user Identity. Qoder
recommends QR-code authorization for Channel binding so channel credentials do not need to be stored locally.

Forward-delivered agents still cannot be referenced by OpenAgentPack deployments; scheduled Managed Deployment runs
require an Agent resource.

## Next steps

- [Multi-provider](./multi-provider.md) — deploy the same agent to both Claude and Qoder.
- Full Qoder config: [`examples/qoder/full/`](../../examples/qoder/full/)

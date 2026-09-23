# Deploy to Bailian

Bailian (Aliyun AgentStudio) manages agents with versioned updates, references **official MCP servers by name** rather than wiring vaults for them, and supports **multi-agent coordinators** whose children run in parallel.

## Provider configuration

```yaml
providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}
    # base_url is derived from workspace_id when omitted:
    # https://<workspace_id>.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `api_key` | yes | DashScope API key (Bearer token). Resolve from `.env` with `${DASHSCOPE_API_KEY}`. |
| `workspace_id` | yes | Bailian workspace id (`llm-...`). Resolve with `${BAILIAN_WORKSPACE_ID}`. |
| `base_url` | no | Override the derived endpoint. When omitted it is derived from `workspace_id`. |

## Capabilities

| Feature | Tier |
|---------|:----:|
| Environment, Vault, Skill, Agent, MCP Server, Session | native |
| Memory Store | unsupported |
| Multi-Agent | native |
| Deployment | native |

- Skills upload as a zip via the Files API (two-step).
- MCP servers are **official managed servers** referenced by `name` (no vault needed for them).
- Deployments are native: `apply` creates the remote deployment, `schedule` runs server-side (cron + timezone), and `deployment run` triggers a server-side run. `user.define_outcome` events and `github_repository` resources are not part of the deployment payload and surface a warning on plan.

## Minimal agent

```yaml
version: "1"

providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}

defaults:
  provider: bailian

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "General-purpose coding assistant"
    model: qwen3.7-max
    instructions: |
      You are a helpful coding assistant.
    environment: dev
    tools:
      builtin: [bash, read, glob, grep]
```

## Multi-agent

A Bailian coordinator delegates to other declared agents. Child agents run in **parallel over a shared file system** — files written by one member are visible to the others, so declare file/directory ownership in the coordinator's instructions:

```yaml
agents:
  researcher:
    model: qwen3.7-max
    instructions: |
      Research the task. Only write files under /work/research/.
    environment: dev
  writer:
    model: qwen3.7-max
    instructions: |
      Turn findings into reports. Only write files under /work/report/.
    environment: dev
  lead:
    model: qwen3.7-max
    instructions: |
      You are the lead agent coordinating a team:
      - researcher: owns /work/research/
      - writer: owns /work/report/
      Child agents run in parallel on one shared file system, so keep each
      member inside its own directory. Delegate, then synthesize into /work/report/.
    environment: dev
    multiagent:
      type: coordinator
      agents: [researcher, writer]
```

Rules and behavior:

- Roster entries are **project logical names**; OpenAgentPack resolves them to remote agent ids. Nesting, cycles, self references, and rosters over 20 members are rejected at plan time.
- Member versions are never declared: each child Thread resolves the latest member version when it is first created and keeps that version for its lifetime.
- Removing `multiagent` from the declaration clears the remote roster on update — the adapter sends Bailian's empty roster for you.
- `self` references, explicit member versions, and Thread management are not exposed by the common schema yet.

See [`examples/bailian/multiagent/`](../../examples/bailian/multiagent/).

## What Bailian uniquely supports

- **Official skills** — reference a platform-provided skill without uploading or managing its lifecycle. See [`examples/bailian/official-skill/`](../../examples/bailian/official-skill/).
- **Official MCP servers** — declare `type: official` and reference by name. See [`examples/bailian/with-mcp/`](../../examples/bailian/with-mcp/).

## Next steps

- Full Bailian config: [`examples/bailian/full/`](../../examples/bailian/full/)
- Runtime session script: [`examples/bailian/basic/run-session.ts`](../../examples/bailian/basic/run-session.ts)

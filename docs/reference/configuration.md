# Configuration reference

The `agents.yaml` schema. Every field below is sourced from the Zod schema in `packages/sdk/src/internal/parser/schema.ts` and the config types in `packages/sdk/src/internal/types/config.ts`. For a tutorial, see [Configure an agent](../guides/configure-an-agent.md).

## Top-level structure

```yaml
version: "1"
providers:    { <name>: <provider-config> }
defaults:     { provider: <name> | "all" }
environments: { <name>: EnvironmentDecl }
vaults:       { <name>: VaultDecl }
memory_stores:{ <name>: MemoryStoreDecl }
skills:       { <name>: SkillDecl }
files:        { <name>: FileDecl }
agents:       { <name>: AgentDecl }
deployments:  { <name>: DeploymentDecl }
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `version` | string | yes | Schema version. Currently `"1"`. |
| `providers` | map | yes | One block per provider; each holds its credentials. |
| `defaults.provider` | string | no | Default target for `plan`/`apply`. `all` targets every declared provider. |
| `environments` | map | no | Cloud runtimes. |
| `vaults` | map | no | Credential stores. |
| `memory_stores` | map | no | Persistent agent context (Qoder, Volcengine Ark). |
| `skills` | map | no | Reusable capability modules. |
| `files` | map | no | Local files uploaded to the Files API (Bailian, Volcengine Ark). |
| `agents` | map | no | The core managed-agent resources. |
| `deployments` | map | no | Repeatable run units. |

Secrets use `${VAR_NAME}` and resolve from `.env` (walking up to the project root). `agents init` appends `agents.state.json` and `.env` to `.gitignore`.

## Provider configuration

Each provider under `providers` is validated by the provider's own config schema.

### Bailian (Aliyun AgentStudio)

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `api_key` | string | yes | DashScope API key. |
| `workspace_id` | string | yes | Bailian workspace id (`llm-...`). |
| `base_url` | string | no | Override the derived endpoint (`https://<workspace_id>.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`). |

### Qoder

| Field | Type | Required | Default | Description |
|-------|------|:--------:|---------|-------------|
| `api_key` | string | yes | — | Qoder PAT. |
| `gateway` | string | no | `https://api.qoder.com/api/v1/cloud` | Cloud gateway base URL. |

### Claude

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `api_key` | string | yes | Anthropic API key. |
| `beta` | string | no | Optional `anthropic-beta` header value. |

### Volcengine Ark (Managed Agents)

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `api_key` | string | yes | Volcengine Ark API key. |

## Environment

```yaml
environments:
  <name>:
    name: <string>            # optional
    description: <string>     # optional
    provider: <string>       # optional; pin to one provider
    config:
      type: cloud
      networking: { ... }
      packages: { ... }
    metadata: { <key>: <string> }
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `config.type` | `"cloud"` | yes | Environment type. |
| `config.networking.type` | `"unrestricted"` \| `"limited"` | no | Network policy. |
| `config.networking.allow_mcp_servers` | boolean | no | Allow outbound MCP. |
| `config.networking.allow_package_managers` | boolean | no | Allow package managers. |
| `config.networking.allowed_hosts` | string[] | no | Allow-list for `limited` networks. |
| `config.packages.apt` \| `pip` \| `npm` \| `cargo` \| `gem` \| `go` | string[] | no | Preinstalled packages. |
| `metadata` | map<string,string> | no | Free-form metadata. |

## Vault

```yaml
vaults:
  <name>:
    display_name: <string>
    provider: <string>          # optional
    credentials: [ CredentialDecl ]
    metadata: { <key>: <string> }
```

`CredentialDecl` is a discriminated union on `type`:

### `static_bearer`

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Credential name. |
| `type` | `"static_bearer"` | yes | |
| `mcp_server_url` | string | yes | MCP server URL. |
| `access_token` | string | yes | Bearer token (string or number, coerced). |
| `protocol` | `"sse"` \| `"streamable_http"` | no | MCP transport. |

### `environment_variable`

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Credential name. |
| `type` | `"environment_variable"` | yes | |
| `secret_name` | string | yes | Secret name. |
| `secret_value` | string | yes | Secret value (string or number, coerced). |
| `networking.type` | `"unrestricted"` \| `"limited"` | no | |

## Memory store

```yaml
memory_stores:
  <name>:
    description: <string>
    provider: <string>          # optional
    entries: [ { key: <string>, content: <string> } ]
```

Supported on **Qoder** and **Volcengine Ark** (**Bailian** and **Claude**: `unsupported`).

## Skill

```yaml
skills:
  <name>:
    source: <string>           # path to skill directory
    description: <string>      # optional
    version: <string>         # optional
    origin: "custom" | "official"   # optional
    provider: <string>        # optional
```

## File

```yaml
files:
  <name>:
    source: <string>
    name: <string>            # optional
    purpose: <string>         # optional
    provider: <string>         # optional
```

## Agent

```yaml
agents:
  <name>:
    description: <string>
    model: <string> | { <provider>: <string> }
    instructions: <string> | <path>
    environment: <string>
    provider: <string>
    tools: { builtin: [...], mcp: [...], permissions: {...} }
    mcp_servers: [ { name, type?, url? } ]
    skills: [ <string> | { type, skill_id, version? } ]
    vault: <string>
    memory_stores: [ <string> ]
    multiagent: { type: "coordinator", agents: [...] }
    metadata: { <key>: <string> }
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `model` | string \| map<provider,string> | yes | Single model or a per-provider map. |
| `instructions` | string | yes | Inline text or a path to a file (resolved relative to the config). |
| `environment` | string | no | Environment name. |
| `provider` | string | no | Pin the agent to one provider. |
| `tools.builtin` | string[] | yes (in `tools`) | Lowercase tool names. |
| `tools.permissions` | map<string,`"allow"`\|`"ask"`> | no | Per-tool permission policy. |
| `tools.mcp[]` | McpToolkitDecl[] | no | Select tools from an official MCP server. |
| `mcp_servers[]` | `{ name, type?, url? }` | no | URL (`url`/`http`) or `official` MCP server. |
| `skills[]` | string \| AgentSkillRef | no | Skill name or `{ type: "official"\|"custom", skill_id, version? }`. |
| `vault` | string | no | Vault name. |
| `memory_stores` | string[] | no | Bound memory stores. |
| `multiagent.type` | `"coordinator"` | no | Declare a coordinator agent. |
| `multiagent.agents` | string[] | yes (with multiagent) | Agents it orchestrates. |
| `metadata` | map<string,string> | no | Free-form metadata. |

### MCP toolkit (`tools.mcp[]`)

```yaml
tools:
  mcp:
    - type: mcp_toolkit
      mcp_server_name: WebSearch      # mcpServerName also accepted
      default_config: { enabled: false }   # defaultConfig also accepted
      configs:
        - name: bailian_web_search
          enabled: true
```

## Deployment

```yaml
deployments:
  <name>:
    agent: <string>
    agent_version: <number>           # optional
    environment: <string>             # optional
    vaults: [ <string> ]
    memory_stores: [ <string> ]
    resources: [ DeploymentResource ]
    initial_events: [ InitialEvent ]  # 1..50
    schedule: { expression: <cron>, timezone: <tz> }
    description: <string>
    provider: <string>
    metadata: { <key>: <string> }
```

`initial_events` is a discriminated union; `schedule.expression` must be a 5-field cron expression.

### Initial events

| Type | Fields |
|------|--------|
| `user.message` | `content` |
| `system.message` | `content` |
| `user.define_outcome` | `description?`, `rubric?` \| `rubric_file?`, `max_iterations?` (int 1–20) |

### Deployment resources

| Type | Fields |
|------|--------|
| `file` | `file_id?`, `source?`, `mount_path?` |
| `memory_store` | `memory_store`, `access?` (`read_write`\|`read_only`), `instructions?` |
| `github_repository` | `url`, `checkout?` (`branch`/`commit`), `mount_path?`, `authorization_token?` |

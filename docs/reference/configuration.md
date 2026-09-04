# Configuration reference

The `agents.yaml` schema. Every field below is sourced from the Zod schema in `packages/sdk/src/internal/parser/schema.ts` and the config types in `packages/sdk/src/internal/types/config.ts`. For a tutorial, see [Configure an agent](../guides/configure-an-agent.md).

## Top-level structure

```yaml
version: "1"
providers:    { <name>: <provider-config> }
defaults:
  provider: <name> | "all"
  identity: <identity-name>
environments: { <name>: EnvironmentDecl }
tunnels:      { <name>: TunnelDecl }
vaults:       { <name>: VaultDecl }
memory_stores:{ <name>: MemoryStoreDecl }
skills:       { <name>: SkillDecl }
files:        { <name>: FileDecl }
identities:   { <name>: IdentityDecl }
agents:       { <name>: AgentDecl }
channels:     { <name>: ChannelDecl }
deployments:  { <name>: DeploymentDecl }
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `version` | string | yes | Schema version. Currently `"1"`. |
| `providers` | map | yes | One block per provider; each holds its credentials. |
| `defaults.provider` | string | no | Default target for `plan`/`apply`. `all` targets every declared provider. |
| `defaults.identity` | string | no | Logical name of the default declared Identity used by identity-aware resources and Forward Sessions. |
| `environments` | map | no | Cloud runtimes. |
| `tunnels` | map | no | Existing Qoder BYOC tunnels referenced by sessions; OpenCMA does not manage their lifecycle. |
| `vaults` | map | no | Credential stores. |
| `memory_stores` | map | no | Persistent agent context (Qoder, Volcengine Ark). |
| `skills` | map | no | Reusable capability modules. |
| `files` | map | no | Local files uploaded to the Files API (Bailian, Volcengine Ark). |
| `identities` | map | no | Stable end-user identities. Provider support is capability-gated. |
| `agents` | map | no | The core managed-agent resources. |
| `channels` | map | no | External messaging channels bound to an Identity and Agent. Provider support is capability-gated. |
| `deployments` | map | no | Repeatable run units. |

Secrets use `${VAR_NAME}` and resolve from `.env` (walking up to the project root). `agents init` appends `agents.state.json` and `.env` to `.gitignore`.

## Identity

Managed identities use the integrating product's stable end-user id:

```yaml
identities:
  chen:
    provider: qoder
    external_id: user_456
    name: Chen
    enabled: true
    metadata:
      department: engineering
```

`agents apply` creates or updates the remote Identity and stores its provider id in state. To reference an Identity managed outside this project, use the mutually exclusive external-reference form:

```yaml
identities:
  chen:
    provider: qoder
    identity_id: idn_019eabc123
```

External references are verified and recorded but never updated or deleted.

## Channel

```yaml
channels:
  support-dingtalk:
    provider: qoder                 # optional; inherits defaults.provider
    agent: support-agent            # required for mode: fixed; ignored for mode: pairing
    identity: chen                  # optional; inherits defaults.identity. ignored for mode: pairing
    type: dingtalk
    mode: fixed                     # optional; defaults to fixed
    name: Support DingTalk          # optional; defaults to the YAML key
    enabled: true                   # optional; defaults to true
    credentials:
      client_id: ${DINGTALK_CLIENT_ID}
      client_secret: ${DINGTALK_CLIENT_SECRET}
    options:
      include_tool_calls: false
      include_thinking: false
```

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `provider` | string | no | Provider name; inherits `defaults.provider`. |
| `agent` | string | conditional | Logical Agent name. Required for `fixed` mode; ignored for `pairing` mode. |
| `identity` | string | conditional | Logical Identity name; inherits `defaults.identity`. Required for `fixed` mode; ignored for `pairing` mode. |
| `type` | string | yes | Provider-specific channel type. Qoder supports `dingtalk`, `feishu`, and `wecom`; `wechat` is QR-only. |
| `mode` | `fixed` \| `pairing` | no | `fixed` (default) binds the channel to one Identity/Template. `pairing` creates a transport-only channel for Schedules/Sinks. |
| `name` | string | no | Display name; defaults to the YAML key. |
| `enabled` | boolean | no | Defaults to `true`. |
| `credentials` | map | conditional | Provider-specific credentials. Required for credential-based channel types. |
| `options` | map | no | Provider-specific response options, e.g. `include_tool_calls`, `include_thinking`. |

The declaration intentionally uses logical `agent` and `identity` references. Provider adapters resolve remote ids and map `type`, `credentials`, and `options` to provider wire fields. Qoder Channels in `fixed` mode require the referenced Agent to use Forward delivery. `pairing` mode omits Identity/Template binding and is intended for Schedule sinks such as scheduled group broadcasts. Credential-based Qoder support currently covers DingTalk, Feishu, and WeCom; personal WeChat remains QR-only.

### Managed tool config

`managed_tool_config` declares the provider-operated tools an Agent Harness runs
itself, rather than tools the model calls through the sandbox. Schedule
management is the current use: enabling `create_forward_schedule`,
`list_forward_schedules`, and `delete_forward_schedule` lets an end user create
and cancel Schedules in natural language from a Web or IM Channel conversation.

`enabled_tools` replaces the provider's whole enabled set, so an empty array
turns every managed tool off. Omitting the field entirely sends nothing: because
Qoder Forward Template updates are merge-style, an undeclared field leaves
whatever the remote Template already had. Declare it whenever the tools matter —
a Template recreated from scratch (after a destroy, a manual deletion, or lost
state) otherwise comes back with no managed tools and no error.

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
    environment_id: <string> # optional; reference an existing provider environment without managing it
    config:
      type: cloud | self_hosted
      networking: { ... }
      packages: { ... }
      setup_script: <string>
    metadata: { <key>: <string> }
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `environment_id` | string | no | Existing environment ID. When present, OpenCMA never creates, updates, or deletes the remote environment. Removing this line later is blocked as an ownership error — release first with `agents state rm` (see [Use BYOC environments](../guides/use-byoc-environments.md)). |
| `config.type` | `"cloud"` \| `"self_hosted"` | yes | Environment type. `self_hosted` is used for Qoder BYOC. |
| `config.networking.type` | `"unrestricted"` \| `"limited"` | no | Network policy. |
| `config.networking.allow_mcp_servers` | boolean | no | Allow outbound MCP. |
| `config.networking.allow_package_managers` | boolean | no | Allow package managers. |
| `config.networking.allowed_hosts` | string[] | no | Allow-list for `limited` networks. |
| `config.packages.apt` \| `pip` \| `npm` \| `cargo` \| `gem` \| `go` | string[] | no | Preinstalled packages. |
| `config.setup_script` | string | no | Sandbox setup script. Qoder runs it with `/bin/bash -lc` after package installation; maximum UTF-8 size is 64 KB. Other providers currently reject this field. |
| `metadata` | map<string,string> | no | Free-form metadata. |

Qoder accepts only `apt`, `npm`, and `pip` in package requests. Its API may return empty `cargo`, `gem`, and `go` arrays as reserved response fields, but declaring non-empty values for them is rejected locally. Setup scripts run while a new sandbox is prepared, time out after 10 minutes, and a non-zero exit prevents the Session from starting. Keep scripts idempotent and use vault-backed credentials instead of embedding secrets.

For a managed Qoder `self_hosted` environment, `config` accepts only `type` and optional `setup_script`; networking and packages belong to cloud environments. External `environment_id` references remain unmanaged.

## Tunnel (Qoder BYOC)

```yaml
tunnels:
  internal-network:
    tunnel_id: tnl_00xxxx
```

Tunnels are existing Qoder resources allocated by the BYOC administrator. They are passed only when a Qoder session/deployment is created and are never created, updated, or deleted by OpenCMA. See [Use BYOC environments](../guides/use-byoc-environments.md) for a complete setup and lifecycle guide.

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
| `networking.type` | `"unrestricted"` \| `"limited"` | conditional | Required when `networking` is present for non-Bailian providers. Bailian requests use `allowed_hosts` instead. |
| `networking.allowed_hosts` | string[] | no | Bailian credential injection host allow-list, e.g. `["api.example.com", "*.example.org"]`; `["*"]` allows all hosts. |
| `injection_location.header` | boolean | no | Bailian: allow secret replacement in request headers. |
| `injection_location.body` | boolean | no | Bailian: allow secret replacement in request bodies. |

For Bailian, these fields are nested under `auth` in credential create/update requests.
When omitted, creation uses `networking: { allowed_hosts: ["*"] }` and
`injection_location: { header: true, body: false }`. Legacy `networking.type: unrestricted`
maps to `["*"]`; `limited` must include `allowed_hosts` and is never widened implicitly.
Explicit host lists and injection booleans are preserved, including through sync/export.
Bailian credential retry adoption compares host sets and injection policy as well as the existing
identity and metadata fields; a different policy is not treated as an exact match.

Credential `networking.allowed_hosts` and `injection_location` are rejected for
non-Bailian providers, whose legacy networking and retry-matching behavior is unchanged.
In multi-provider projects, pin such vaults with `provider: bailian` (or select
Bailian via `defaults.provider`) to avoid applying these fields to other providers.

## Memory store

```yaml
memory_stores:
  <name>:
    description: <string>
    provider: <string>          # optional
	metadata: { <string>: <string> } # optional
    entries: [ { key: <string>, content: <string> } ]
```

Supported on **Qoder**, **Claude (beta)**, and **Volcengine Ark** (**Bailian**: `unsupported`).

Declarative `entries` are managed seeds: apply creates or updates those paths but
preserves additional memories written by agents. Runtime CRUD and version commands
are documented in [`examples/memory/`](../../examples/memory/README.md).

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
    tunnel: <string>              # optional; Qoder BYOC tunnel name
    provider: <string>
    tools: { builtin: [...], default_permission: allow, mcp: [...], permissions: {...} }
    mcp_servers: [ { name, type?, url? } ]
    skills: [ <string> | { type, skill_id, version? } ]
    vault: <string>
    memory_stores: [ <string> ]
    default_memory_store:             # Qoder Forward only; requires defaults.identity
      name: <string>                  # 1-255 characters
      description: <string>           # optional; up to 1024 characters
      delete_on_destroy: <boolean>    # optional; defaults to false (retain)
    environment_variables: { <key>: <string> }  # Qoder only
    managed_tool_config: { enabled_tools: [ <string> ] }  # Qoder Forward delivery only
    resources: [ SessionResource ]
    multiagent: { type: "coordinator", agents: [...] }
    metadata: { <key>: <string> }
```

### Qoder Forward default Memory Store

Qoder creates one writable, system-managed Memory Store for an `(Identity, Template)` pair when its first Forward Session is created. `default_memory_store` lets OpenCMA manage the display metadata and destroy policy of that provider-created Store; it does not declare a second, ordinary entry under the top-level `memory_stores` collection.

```yaml
defaults:
  provider: qoder
  identity: support-user

identities:
  support-user:
    external_id: support-user       # managed by OpenCMA

agents:
  support:
    # ...
    delivery:
      qoder:
        type: forward
    default_memory_store:
      name: "Support group memory"
      description: "Confirmed support knowledge and operating rules"
      delete_on_destroy: false
```

Apply behavior:

- Requires Qoder Forward delivery and `defaults.identity`.
- Locates the Store mounted as `system_managed: true` and `access: read_write`, then idempotently updates its `name` and optional `description`.
- Does not create an initialization Session. Before the first real Session has created the Store, apply reports the reconciliation as pending. Run apply again after a Session exists.
- `name` changes the provider Store's display name, so it can be meaningful instead of remaining the provider-generated default.

Destroy behavior:

| `delete_on_destroy` | Result |
|---|---|
| omitted or `false` | Retain the Store, its Memories, and all version history. This is the default. |
| `true` | Permanently delete the Store, its Memories, and all version history after its system mount has been removed. |

For permanent deletion, OpenCMA captures and persists the Store ID before archiving the Template and deleting the Identity. Qoder may remove the system mount asynchronously, so OpenCMA uses bounded retries for a `still mounted` conflict. If the conflict remains, it tries `archive → delete`, matching the lifecycle verified against the live Qoder service. A cleanup that still cannot finish is retained in state and reported as a partial destroy; a later `agents destroy` resumes it even when all ordinary resources are already gone.

If the preflight cannot resolve the Identity, Template, or Store lookup, destroy aborts before deleting any project resource. Authentication, permission, and non-retryable validation errors fail immediately. `--cascade` does not override this field.

`delete_on_destroy: true` requires an OpenCMA-managed Identity. An external `identity_id` is never deleted by OpenCMA, so it keeps the system Store mounted and fails configuration validation. Permanent deletion is irreversible; keep the default `false` unless data removal is explicitly required.

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `model` | string \| map<provider,string> | yes | Single model or a per-provider map. |
| `instructions` | string | yes | Inline text or a path to a file (resolved relative to the config). |
| `environment` | string | no | Environment name. |
| `tunnel` | string | no | Qoder BYOC tunnel name from `tunnels`; unsupported for other providers. |
| `provider` | string | no | Pin the agent to one provider. |
| `tools.builtin` | string[] | yes (in `tools`) | Lowercase tool names. |
| `tools.default_permission` | `"allow"` \| `"ask"` | no | Permission inherited by enabled builtins; defaults to `allow`. |
| `tools.permissions` | map<string,`"allow"`\|`"ask"`> | no | Case- and separator-insensitive overrides for enabled builtins. Unknown and duplicate normalized names are rejected. |
| `tools.mcp[]` | McpToolkitDecl[] | no | Select tools from an official MCP server. |
| `mcp_servers[]` | `{ name, type?, url? }` | no | URL (`url`/`http`) or `official` MCP server. |
| `skills[]` | string \| AgentSkillRef | no | Skill name or `{ type: "official"\|"custom", skill_id, version? }`. |
| `vault` | string | no | Vault name. |
| `files` | string[] | no | File declarations inherited by a Qoder Forward Template. These files are created through the Forward File API. |
| `memory_stores` | string[] | no | Bound memory stores. |
| `default_memory_store.name` | string | yes (with `default_memory_store`) | Display name for Qoder Forward's writable system-managed Store; 1–255 characters. |
| `default_memory_store.description` | string | no | Display description for the system-managed Store; up to 1024 characters. |
| `default_memory_store.delete_on_destroy` | boolean | no | Permanently delete the Store during destroy. Defaults to `false` (retain). |
| `environment_variables` | map<string,string> | no | Qoder runtime variables. Managed Sessions use Qoder's `KEY=VALUE;...` wire format; Forward Templates store the map as defaults and Forward Sessions send it under `config.environment_variables`. |
| `managed_tool_config.enabled_tools` | string[] | no | Provider-operated tools the Agent Harness exposes, e.g. `create_forward_schedule`, `list_forward_schedules`, `delete_forward_schedule`. Qoder Forward delivery only; declaring it on managed delivery is a validation error. |
| `resources` | SessionResource[] | no | Resources attached to every managed Session created for the Agent. |
| `multiagent.type` | `"coordinator"` | no | Declare a coordinator agent. |
| `multiagent.agents` | string[] | yes (with multiagent) | Agents it orchestrates. |
| `metadata` | map<string,string> | no | Free-form metadata. |

For Qoder Forward delivery, a locally declared Environment is created only through the Forward Environment API. An
external `environment_id` may reference an Environment from either the Managed API or the Forward API; OpenCMA does
not create or mutate such a reference and resolves its API domain when checking existence. Referenced custom Skills, Vaults and Credentials, Files, and explicit
Memory Stores are created through their Forward APIs. A locally managed Environment, Skill, Vault, File, or Memory
Store cannot be shared by Managed and Forward Agents under one logical declaration; declare separate resources for
the two API domains. Explicit Forward Memory Stores require `defaults.identity` and are mounted read-only to that
Identity and Template.

### Session resources

Qoder and Claude managed Sessions support a provider-neutral GitHub repository resource:

```yaml
agents:
  reviewer:
    # ...
    resources:
      - type: github_repository
        url: https://github.com/acme/private-repo.git
        authorization_token: ${GITHUB_TOKEN}
        checkout: { branch: main } # or: { commit: <full-sha> }
        mount_path: /data/workspace/private-repo # optional
```

Keep `authorization_token` in `.env`; never put its value directly in `agents.yaml`. Qoder mount paths must start with `/data/`. If the field is omitted for Qoder, OpenAgentPack sends `/data/workspace/<repo-name>` automatically; for the URL above that is `/data/workspace/private-repo`. Qoder requires this `/data` path for the repository mount to take effect. Other providers retain their own path semantics.

Mount roots are provider invariants: Qoder uses `/data`, Claude uses `/workspace`, and Bailian and Ark use `/mnt`. A relative uploaded-file path is resolved under the target root. An explicit absolute path must already use the matching root and is passed through unchanged; OpenAgentPack rejects mismatched absolute paths instead of silently rewriting them. For GitHub Session resources, when the path is omitted Qoder derives `/data/workspace/<repo-name>` and Claude derives `/workspace/<repo-name>`.

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
    tunnel: <string>                  # optional; Qoder BYOC only (see note below)
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

> **Deployment `tunnel` caveat:** Qoder's deployment API does not accept `tunnel_id`, so the tunnel is dropped from the deployment payload and server-side runs execute without it (`validate`/`plan` emits a warning). Use sessions for private-network MCP access; see [Use BYOC environments](../guides/use-byoc-environments.md).

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

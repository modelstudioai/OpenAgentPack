# Configure an agent

This guide builds an `agents.yaml` up from the minimal case to a full stack. Runnable versions of each stage live under [`examples/`](../../examples). For every field, see the [Configuration reference](../reference/configuration.md).

## Minimal config

The smallest useful config declares one provider and one agent:

```yaml
version: "1"

providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}

defaults:
  provider: claude

agents:
  assistant:
    description: "General-purpose coding assistant"
    model: claude-sonnet-4-6
    instructions: |
      You are a coding assistant.
    tools:
      builtin: [read, glob, grep]
```

- `version` — config schema version (currently `"1"`).
- `providers` — one block per provider you target; each holds its credentials.
- `defaults.provider` — which provider `plan`/`apply` use when `--provider` is omitted. Set it to `all` to target every declared provider at once.
- `agents` — a map of agent name → definition.

Secrets use `${VAR_NAME}` and resolve from `.env`. Never inline a real key.

## Environments

An **environment** is the cloud runtime an agent runs in — its network policy and preinstalled packages.

```yaml
environments:
  dev:
    description: "Development environment with full network access"
    config:
      type: cloud
      networking:
        type: unrestricted

  staging:
    config:
      type: cloud
      networking:
        type: limited
        allow_mcp_servers: true
        allow_package_managers: true
        allowed_hosts:
          - "api.github.com"
          - "registry.npmjs.org"
      packages:
        apt: [git, curl]
        npm: [typescript]
```

Reference an environment from an agent with `environment: dev`.

## Instructions

`instructions` accepts either an inline string or a path to a file:

```yaml
agents:
  lead:
    instructions: ./prompts/lead.md    # loaded relative to the config file
```

## Tools

```yaml
tools:
  builtin: [read, glob, grep, web_search, web_fetch, write, edit, bash]
  permissions:
    read: allow
    glob: allow
    bash: ask
```

Built-in tool names are lowercase in config. When targeting Qoder (which uses PascalCase natively), OpenAgentPack converts them automatically — see [Provider reference](../reference/providers.md).

## Skills

A **skill** is a reusable capability module uploaded from a local directory:

```yaml
skills:
  code-review:
    source: ./skills/code-review/
    description: "Structured code review with severity levels"

agents:
  reviewer:
    skills: [code-review]
```

See [Use skills](./use-skills.md).

## Vaults and MCP servers

A **vault** stores credentials for external tool servers reached over MCP:

```yaml
vaults:
  api-credentials:
    display_name: "API Credentials"
    credentials:
      - name: github-mcp
        mcp_server_url: "https://mcp.example.com/github"
        type: static_bearer
        access_token: ${MCP_GITHUB_TOKEN}
        protocol: streamable_http

agents:
  lead:
    mcp_servers:
      - name: github
        url: "https://mcp.example.com/github"
    vault: api-credentials
```

See [Use MCP and vaults](./use-mcp-and-vaults.md).

## Memory stores (Qoder, Claude beta, Ark)

```yaml
memory_stores:
  project-memory:
    description: "Persistent project context"

agents:
  assistant:
    memory_stores: [project-memory]
```

## Multi-agent coordination (Claude, Ark)

One agent can orchestrate others in `coordinator` mode:

```yaml
agents:
  lead:
    multiagent:
      type: coordinator
      agents: [researcher, reviewer]
```

## Deployments

A **deployment** bundles an agent, its runtime bindings, initial events, and a schedule into a repeatable run unit managed by `plan`/`apply`:

```yaml
deployments:
  nightly-review:
    agent: reviewer
    environment: dev
    schedule: "0 2 * * *"
```

See [Manage deployments](./manage-deployments.md).

## Full example

See [`examples/claude/full/`](../../examples/claude/full/) for a config that combines environments, vaults, skills, multi-agent coordination, and metadata in one file.

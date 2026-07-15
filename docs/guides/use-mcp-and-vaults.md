# Use MCP and vaults

An **MCP server** is an external tool server reached over the MCP protocol. A **vault** stores the credentials an agent needs to reach those servers.

## Declare a vault

A vault holds one or more credentials. Two credential types are supported:

```yaml
vaults:
  api-credentials:
    display_name: "API Credentials"
    credentials:
      # static bearer token for an MCP server
      - name: github-mcp
        mcp_server_url: "https://mcp.example.com/github"
        type: static_bearer
        access_token: ${MCP_GITHUB_TOKEN}
        protocol: streamable_http
      # environment-variable-backed secret
      - name: db-mcp
        type: environment_variable
        secret_name: DB_TOKEN
        secret_value: ${DB_TOKEN}
        networking:
          type: limited
```

| Credential type | Key fields |
|-----------------|------------|
| `static_bearer` | `mcp_server_url`, `access_token`, `protocol` (`sse` \| `streamable_http`) |
| `environment_variable` | `secret_name`, `secret_value`, optional `networking` |

Secrets are referenced with `${VAR_NAME}` and loaded from `.env`; never inline a real token.

## Attach MCP servers to an agent

Reference a URL-based MCP server and bind the vault that holds its token:

```yaml
agents:
  lead:
    mcp_servers:
      - name: github
        url: "https://mcp.example.com/github"
    vault: api-credentials
```

## Official MCP servers (Bailian)

On Bailian, MCP servers are platform-managed "official" servers referenced by **name** — no vault is required because the platform manages credentials:

```yaml
agents:
  researcher:
    tools:
      builtin: [read, glob, grep]
      mcp:
        - type: mcp_toolkit
          mcpServerName: WebSearch
          defaultConfig:
            enabled: false
          configs:
            - name: bailian_web_search
              enabled: true
    mcp_servers:
      - type: official
        name: WebSearch
```

The `mcp_toolkit` block (under `tools.mcp[]`) selects which tools the official server exposes. It accepts either snake_case (`mcp_server_name`, `default_config`) or camelCase (`mcpServerName`, `defaultConfig`) keys.

## Network policy

For an agent that needs outbound MCP access, use a `limited` environment and allow MCP servers explicitly:

```yaml
environments:
  prod:
    config:
      type: cloud
      networking:
        type: limited
        allow_mcp_servers: true
        allowed_hosts:
          - "mcp.example.com"
          - "api.github.com"
```

## Examples

- URL MCP + vault + restricted network: [`examples/claude/with-mcp/`](../../examples/claude/with-mcp/)
- Official MCP server: [`examples/bailian/with-mcp/`](../../examples/bailian/with-mcp/)
- Vault + multi-agent: [`examples/ark/full/`](../../examples/ark/full/)

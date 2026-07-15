# Resources

OpenAgentPack manages a small set of resource types and the dependencies between them. This page lists what you declare in `agents.yaml`; for the exact fields see the [Configuration reference](../reference/configuration.md).

## Declared resources

These are the top-level blocks you write in a config. Each maps to a state-tracked resource type (`environment`, `vault`, `memory_store`, `skill`, `file`, `agent`, `deployment`).

| Block | Resource | What it is |
|-------|----------|------------|
| `environments` | environment | The cloud runtime an agent runs in — network policy and preinstalled packages. |
| `vaults` | vault | Credential store for MCP-server access tokens. |
| `memory_stores` | memory_store | Persistent context for an agent *(Qoder, Ark)*. |
| `skills` | skill | Reusable capability module uploaded from a local directory. |
| `files` | file | A local file uploaded to the provider's Files API *(Bailian, Ark)*. |
| `agents` | agent | The core resource — combines the above into a complete AI agent. |
| `deployments` | deployment | A repeatable run unit bundling an agent + bindings + initial events + schedule. |

Two more facets are expressed *through* an agent rather than as standalone blocks:

- **MCP server** — declared on `agents.<name>.mcp_servers[]`; an external tool server reached over the MCP protocol.
- **Multi-agent** — declared on `agents.<name>.multiagent`; one agent orchestrates others in `coordinator` mode *(Claude, Ark)*.

`session` is a runtime concept, not a declared resource — see [Sessions and deployments](./sessions-and-deployments.md).

## Dependency graph

Resources form a dependency graph that `plan`/`apply` topologically sort:

```text
environment ──▶ agent
skill ────────▶ agent
vault ────────▶ agent
memory_store ─▶ agent
agent ──┬─────▶ deployment
        └─────▶ agent (coordinator depends on the agents it orchestrates)
```

- Dependencies are created before dependents.
- If a resource fails to apply, its dependents are **skipped** rather than attempted against missing prerequisites — a run never leaves a half-built agent pointing at an environment that failed to create.

## Provider support is per-resource

Not every provider supports every resource. Whether a resource kind is available on a provider is an explicit, machine-verified matrix — see [Provider reference](../reference/providers.md). An unsupported facet is a validation error with remediation guidance, not a runtime surprise.

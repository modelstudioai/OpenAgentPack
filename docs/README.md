# OpenAgentPack Documentation

English files are the canonical source for behavior; translated files use a `.zh-CN.md` suffix and describe the same public contract. This index organizes documentation by what you want to do.

## Getting started

| Doc | What's inside |
|-----|---------------|
| [Getting started](./getting-started.md) | Shortest path from install to a running session. (中文：[getting-started.zh-CN.md](./getting-started.zh-CN.md)) |

## Concepts

Mental model behind `plan` and `apply` — no field tables.

| Doc | What's inside |
|-----|---------------|
| [Agents as code](./concepts/agents-as-code.md) | Why a declarative `agents.yaml` instead of console clicks. |
| [Resources](./concepts/resources.md) | The resource types OpenAgentPack manages and their dependencies. |
| [State and drift](./concepts/state-and-drift.md) | The three sources of truth and how drift is reconciled. |
| [Sessions and deployments](./concepts/sessions-and-deployments.md) | Infrastructure resources vs. runtime runs. |

## Guides

Task-oriented, with steps and verification.

| Doc | What's inside |
|-----|---------------|
| [Configure an agent](./guides/configure-an-agent.md) | Build an `agents.yaml` from minimal to full stack. |
| [Deploy to Bailian](./guides/deploy-to-bailian.md) | Bailian (Aliyun AgentStudio) setup and notes. |
| [Deploy to Qoder](./guides/deploy-to-qoder.md) | Qoder-specific setup and notes. |
| [Use BYOC environments](./guides/use-byoc-environments.md) | Connect Qoder sessions to administrator-provisioned self-hosted environments and private-network tunnels. |
| [Deploy to Claude](./guides/deploy-to-claude.md) | Claude-specific setup and notes. |
| [Deploy to Volcengine Ark](./guides/deploy-to-ark.md) | Volcengine Ark (Managed Agents) setup and notes. |
| [Use skills](./guides/use-skills.md) | Author and attach reusable capability modules. |
| [Use MCP and vaults](./guides/use-mcp-and-vaults.md) | Connect external tool servers and manage their credentials. |
| [Multi-provider](./guides/multi-provider.md) | Deploy the same agent to more than one provider. |
| [Run sessions](./guides/run-sessions.md) | Start runtime conversations from a managed agent. |
| [Manage deployments](./guides/manage-deployments.md) | Scheduled / triggered runs and outcome rubrics. |

## Reference

Stable facts — fields, commands, provider matrix, API.

| Doc | What's inside |
|-----|---------------|
| [Configuration reference](./reference/configuration.md) | Every `agents.yaml` field: type, required, default, provider support. |
| [CLI reference](./reference/cli.md) | Every `agents` command, options, and behavior. |
| [Provider reference](./reference/providers.md) | Capability matrix and per-provider configuration. |
| [SDK reference](./reference/sdk.md) | Public `@openagentpack/sdk` API surface. |
| [OpenAPI reference](./reference/openapi.md) | The HTTP surface exposed by `apps/server`. |

## Architecture

For contributors and deep users.

| Doc | What's inside |
|-----|---------------|
| [How it works](./architecture/how-it-works.md) | State management, dependency graph, incremental diffing. |

## Contributing

For external contributors.

| Doc | What's inside |
|-----|---------------|
| [Contributing overview](../CONTRIBUTING.md) | Dev setup, merge requirements, code style. |
| [Maintainer review](./contributing/maintainer-review.md) | Evidence-based PR review and merge gates. |
| [Development](./contributing/development.md) | Clone, install, run, test, package boundaries. |
| [Provider development](./contributing/provider-development.md) | The six files a new provider must implement. |
| [Release](./contributing/release.md) | npm publishing workflow and Trusted Publishing. |

## Conventions

- Design briefs and trade-off notes under package-specific documentation describe implementation history and do not override the public contract above.
- Provider capability tables are verified against the SDK declarations by `scripts/provider-docs.test.ts`; the canonical matrix lives in [Provider reference](./reference/providers.md).

# OpenAgentPack

**English** | [简体中文](./README.zh-CN.md)

> **Manage, review, and migrate cloud AI agents with Git and YAML.**
>
> The open-source IaC control plane for managed AI agents.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@openagentpack/cli?label=npm&color=cb3837)](https://www.npmjs.com/package/@openagentpack/cli)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> [!IMPORTANT]
> OpenAgentPack is in beta. Public APIs and the `agents.yaml` schema may change before `1.0`. See the [changelog](./CHANGELOG.md).

![OpenAgentPack CLI: from agents.yaml to plan and apply](./packages/sdk/docs/agents.gif)

`agents.yaml → validate → plan → apply`: bring agents back into Git, review the pending changes, then update remote resources.

One `agents.yaml` defines an agent's environment, model, instructions, tools, skills, MCP servers, vaults, and credentials. Review every change in a PR, preview it with `plan`, and apply it when ready — instead of rebuilding the same agent through console clicks.

- **Reviewable agent assets** — keep prompts, tools, skills, and configuration in Git; reuse, roll back, and hand them off.
- **Predictable changes** — `validate → plan → apply` previews creates, updates, and deletes before changing remote resources.
- **Portable core declaration** — target Bailian, Qoder, Claude, or Volcengine Ark with an explicit [provider capability contract](./docs/reference/providers.md).

```bash
npm install -g @openagentpack/cli
agents init
# Configure one provider's credentials, then:
agents validate && agents plan
```

[Run the 5-minute quick start](./docs/getting-started.md) · [View provider support](./docs/reference/providers.md) · [Browse runnable examples](./docs/examples.md) · [Roadmap](./ROADMAP.md)

▶ [Watch the Playground demo: switch provider and run the same agent scenario](https://github.com/user-attachments/assets/bf51b8d8-f2ed-464b-bca9-0709fefcc44d)

## Why now

Agents are moving from personal tools to enterprise digital workers. But the things that make an agent valuable — its prompts, skills, knowledge files, tools, and runtime configuration — still live mainly inside cloud-provider consoles.

These are business assets. They should be managed, reviewed, handed over, reproduced, and migrated like code, data, and documents — not trapped as a pile of clicks in one console.

## Why OpenAgentPack

OpenAgentPack puts a declarative control plane between the agent and the cloud platform. The enterprise owns the declaration; provider adapters render it into real managed agents on Bailian, Qoder, Claude, or Volcengine Ark.

The goal is to make an agent an enterprise-controlled, portable, and inheritable digital asset.

<p align="center">
  <img src="https://img.alicdn.com/imgextra/i3/O1CN01xWDp5P1EP90HOZx9q_!!6000000000343-2-tps-1254-1254.png" width="360" alt="OpenAgentPack: one agents.yaml for multiple managed-agent providers">
</p>

### Declaration and portability: the agent as a blueprint

Borrowing Docker's declarative idea, OpenAgentPack brings everything that determines what an agent is — model, instructions, tools, skills, environment, files, and credential references — into one `agents.yaml` blueprint. The blueprint can live in Git, pass through pull-request review, reproduce an agent, and move across providers.

### State and governance: plan before execution

Borrowing Terraform's state-driven workflow, OpenAgentPack keeps desired config, local state, and remote state distinct. `plan` previews creates, updates, and deletes; `apply` executes them in dependency order; drift detection finds console-side changes; and a previous declaration can restore a known-good configuration.

### Validation and experience: Playground as the showroom

Even a precise blueprint needs to be experienced. Playground runs real sessions from the same declaration and lets teams exercise the same scenario against different providers. Provider comparison becomes an observable result, not only a capability matrix.

> OpenAgentPack uses a Docker-like declaration to draw the agent blueprint, a Terraform-like state model to manage construction and acceptance, and Playground as the showroom — so enterprises can manage agents the way they manage code.

The mechanics are a single `agents.yaml`, a `validate → plan → apply` workflow, content-hash diffing, dependency-aware ordering, and drift recovery. The YAML remains the source of truth. See [Agents as code](./docs/concepts/agents-as-code.md) for the mental model and [CONTEXT.md](./CONTEXT.md) for the precise vocabulary.

- **Declarative** — one `agents.yaml` describes your whole agent stack. Commit it, review it in a PR, roll it back.
- **Terraform-style workflow** — `validate → plan → apply`. Preview every create / update / delete before it happens.
- **Multi-provider** — reuse the core declaration across Bailian, Qoder, Claude, and Volcengine Ark; the [capability contract](./docs/reference/providers.md) makes native, emulated, and unsupported differences explicit.
- **Incremental** — content-hash diffing updates only what actually changed; no redundant API calls.
- **Dependency-aware** — Environment → Skill → Agent are created in topological order; a failed dependency skips its dependents instead of leaving half-built state.
- **Drift recovery** — detects when remote config has drifted from your declaration and reconciles it. The YAML is always the single source of truth.

## Quick start

```bash
agents init            # interactive wizard writes a starter agents.yaml
agents validate        # offline YAML check, no API calls
agents plan            # preview create / update / delete
agents apply -y        # apply changes
agents destroy         # tear down managed resources
```

Run `agents playground` to launch the local WebUI, and use `--provider` to target `bailian`, `qoder`, `ark`, or `claude`. You can switch providers on the same declaration, run real sessions, and observe tool calls and artifacts.

▶ [Watch the full Playground demo](https://github.com/user-attachments/assets/bf51b8d8-f2ed-464b-bca9-0709fefcc44d)

A minimal config:

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
      You are a coding assistant.
    environment: dev
    tools:
      builtin: [bash, read, glob, grep]
```

Secrets are referenced with `${VAR_NAME}` and loaded from `.env` — they never live in the config itself. For the full walkthrough, see [Getting started](./docs/getting-started.md).

## Installation

Install the CLI globally:

```bash
# with Bun
bun add -g @openagentpack/cli

# or with npm
npm install -g @openagentpack/cli
```

This provides the `agents` command. To run from source instead, see [Contributing](./CONTRIBUTING.md).
Beta testers can install `@openagentpack/cli@beta`; see the [release guide](./docs/contributing/release.md#what-users-install) for version pinning and switching back to stable.

## Provider support

| Feature | Bailian | Qoder | Claude | Volcengine Ark |
|---------|:-------:|:-----:|:------:|:--------------:|
| Environment | native | native | native | native |
| Vault | native | native | native | native |
| Skill | native | native | native | native |
| Agent | native | native | native | native |
| MCP Server | native | native | native | native |
| Memory Store | unsupported | native | native | native |
| Multi-Agent | unsupported | unsupported | native | native |
| Deployment | emulated | native | native | emulated |
| Session | native | native | native | native |

The full capability matrix and per-provider differences live in the [Provider reference](./docs/reference/providers.md).

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Getting started](./docs/getting-started.md) | Shortest path from install to a running session. |
| [Configuration guide](./docs/guides/configure-an-agent.md) | Progressive tutorial from minimal to full config. |
| [Configuration reference](./docs/reference/configuration.md) | Every `agents.yaml` field, typed and explained. |
| [CLI reference](./docs/reference/cli.md) | Every `agents` command, options, and behavior. |
| [Provider reference](./docs/reference/providers.md) | Capability matrix and per-provider configuration. |
| [How it works](./docs/architecture/how-it-works.md) | State, dependency graph, incremental diffing. |
| [Examples](./docs/examples.md) | Runnable configs indexed by what you want to do. |

The [documentation index](./docs/README.md) organizes the rest by reader goal: concepts, guides, reference, architecture, and contributing.

## Examples

The [`examples/`](./examples) directory has runnable configs for every provider, from a minimal agent to full-feature stacks (skills, MCP, vaults, multi-agent, deployments). Start with `examples/bailian/basic/`.

## Using the SDK

Everything the CLI does is available programmatically from `@openagentpack/sdk`:

```ts
import { resolveProjectConfig, planProjectContext } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

See the [SDK reference](./docs/reference/sdk.md) for the public API surface.

## WebUI

`apps/webui` is a Vite single-page app for browsing playbooks and driving agent sessions; `apps/server` exposes the SDK over an OpenAPI surface. Run both from the repo root:

```bash
bun install
bun run dev        # server + webui together
```

Or launch a packaged local UI with `agents playground --provider <bailian|qoder|ark|claude>`.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, merge requirements, and how to add a new provider. All participants are expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

Use [GitHub Discussions](https://github.com/modelstudioai/OpenAgentPack/discussions) for questions and design proposals, and [GitHub Issues](https://github.com/modelstudioai/OpenAgentPack/issues) for reproducible bugs and accepted work. Current priorities are tracked in the [public roadmap](./ROADMAP.md).

## Security

Found a vulnerability? Please follow the process in [SECURITY.md](./SECURITY.md) — do not open a public issue.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

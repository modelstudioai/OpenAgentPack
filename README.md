# OpenAgentPack

**English** | [简体中文](./README.zh-CN.md)

> **Manage, review, and migrate cloud AI agents with Git and YAML.**
>
> The open-source IaC control plane for managed AI agents.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

<p align="center">
  <img src="https://img.alicdn.com/imgextra/i3/O1CN01xWDp5P1EP90HOZx9q_!!6000000000343-2-tps-1254-1254.png" width="360" alt="OpenAgentPack: one agents.yaml for multiple managed-agent providers">
</p>

One `agents.yaml` defines an agent's environment, model, instructions, tools, skills, MCP servers, vaults, and credentials. Review every change in a PR, preview it with `plan`, and apply it when ready — instead of rebuilding the same agent through console clicks.

- **Reviewable agent assets** — keep prompts, tools, skills, and configuration in Git; reuse, roll back, and hand them off.
- **Predictable changes** — `validate → plan → apply` previews creates, updates, and deletes before changing remote resources.
- **Portable core declaration** — target Bailian, Qoder, Claude, or Volcengine Ark with an explicit [provider capability contract](./docs/reference/providers.md).

```bash
npm install -g @openagentpack/cli
agents init && agents validate && agents plan
```

[Run the 5-minute quick start](./docs/getting-started.md) · [View provider support](./docs/reference/providers.md) · [Browse runnable examples](./docs/examples.md)

## Why now

Agent harnesses are converging on a stable shape — environment, vault, memory, skills, files, MCP servers, prompt, agent loop, multi-agent orchestration. Two shifts ride alongside: agents moving from local runtimes to remote managed ones, and AI-native teams moving from individual productivity to organizational productivity. What's still missing is **reliable, portable agent infrastructure** that doesn't lock you to one provider.

## Why OpenAgentPack

You built an agent somewhere — a prompt, tools, skills, knowledge files, credentials, runtime settings. Those are your business assets, but today they live as a pile of clicks inside one vendor's console: impossible to review in a PR, roll back, reproduce, or move. As agents move from "call a model API in your own code" to "assemble an agent inside a vendor console", vendor lock-in re-forms **one layer up** — at the managed harness. OpenAgentPack is a bet against that.

OpenAgentPack turns those assets into a portable agent definition that deploys to different agent platforms. Three things this gives you:

### No platform lock-in

Your agent isn't locked to one platform. Today on Bailian, tomorrow on Qoder / Claude / Volcengine Ark — and more to come.

### Reproduce, migrate, compare

The same agent can run on multiple platforms; see which is cheaper, better, or faster.

### Your agent is your asset

Prompts, tools, skills, knowledge files, configuration — no longer just a pile of clicks in a console, but something you can save, reuse, review, and hand off.

Focus on business innovation, not on babysitting agent infra. Switch providers the way Docker lets you switch hosts, and keep your definition intact across the move.

The rest is mechanics: a single `agents.yaml`, a `validate → plan → apply` workflow, content-hash diffing, dependency-aware ordering, drift recovery. The YAML is always the single source of truth. See [Agents as code](./docs/concepts/agents-as-code.md) for the mental model and [CONTEXT.md](./CONTEXT.md) for the precise vocabulary (agent harness vs. agent infra, capability contract).

- **Declarative** — one `agents.yaml` describes your whole agent stack. Commit it, review it in a PR, roll it back.
- **Terraform-style workflow** — `validate → plan → apply`. Preview every create / update / delete before it happens.
- **Multi-provider** — the same agent definition deploys to Bailian, Qoder, Claude, or Volcengine Ark. Switch vendors by changing two lines.
- **Incremental** — content-hash diffing updates only what actually changed; no redundant API calls.
- **Dependency-aware** — Environment → Skill → Agent are created in topological order; a failed dependency skips its dependents instead of leaving half-built state.
- **Drift recovery** — detects when remote config has drifted from your declaration and reconciles it. The YAML is always the single source of truth.

## Demo

### CLI workflow

![OpenAgentPack CLI workflow](./packages/sdk/docs/agents.gif)

### Local Playground

`agents playground` launches a local WebUI, fetches the matching `@openagentpack/playground` package on demand, and opens it in your browser. Use `--provider` to target `bailian`, `qoder`, `ark`, or `claude`.

[Watch the Playground demo video](https://cloud.video.taobao.com/vod/f9cVQvN8vYeW2YfRZ59qv5SgJUDgsm-r48mpKIB0Has.mp4)

## Quick start

```bash
agents init            # interactive wizard writes a starter agents.yaml
agents validate        # offline YAML check, no API calls
agents plan            # preview create / update / delete
agents apply -y        # apply changes
agents destroy         # tear down managed resources
```

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

## Provider support

| Feature | Bailian | Qoder | Claude | Volcengine Ark |
|---------|:-------:|:-----:|:------:|:--------------:|
| Environment | native | native | native | native |
| Vault | native | native | native | native |
| Skill | native | native | native | native |
| Agent | native | native | native | native |
| MCP Server | native | native | native | native |
| Memory Store | unsupported | native | unsupported | native |
| Multi-Agent | unsupported | unsupported | native | native |
| Deployment | emulated | emulated | native | emulated |
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

## Security

Found a vulnerability? Please follow the process in [SECURITY.md](./SECURITY.md) — do not open a public issue.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

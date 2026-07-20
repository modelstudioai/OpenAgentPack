# Getting started

This guide takes you from zero to a running agent session in a few minutes. It uses Bailian as the example provider; the same workflow works for Qoder, Claude, and Volcengine Ark (see [Provider reference](./reference/providers.md) for their credentials).

## Prerequisites

- A provider account and API key for one of:
  - Claude — `ANTHROPIC_API_KEY`
  - Qoder — `QODER_PAT`
  - Bailian (Aliyun AgentStudio) — `DASHSCOPE_API_KEY` and `BAILIAN_WORKSPACE_ID`
  - Volcengine Ark (Managed Agents) — `ARK_API_KEY`
- To run the project from source: [Bun](https://bun.sh) `1.3.5` (see [Development](./contributing/development.md)). To use the published CLI, Node.js or Bun is enough.

## Install

Install the CLI globally:

```bash
# with Bun
bun add -g @openagentpack/cli

# or with npm
npm install -g @openagentpack/cli
```

This provides the `agents` command. Verify it:

```bash
agents --version
```

## Create your first project

```bash
mkdir my-agents && cd my-agents
agents init
```

The init wizard asks two questions — which provider(s) to use and what to name your first agent — then writes a starter `agents.yaml`. It also appends `agents.state.json` and `.env` to `.gitignore` so state and secrets never get committed.

The generated file for the `bailian` provider and an agent named `assistant` looks like this:

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
    description: "General-purpose assistant"
    model: qwen3.7-max
    instructions: |
      You are a helpful assistant.
    environment: dev
    tools:
      builtin: [bash, read, glob, grep]
```

## Configure credentials

OpenAgentPack resolves `${VAR_NAME}` references from a `.env` file next to the config (walking up to the project root). Create one:

```bash
cat > .env <<'EOF'
DASHSCOPE_API_KEY=sk-...
BAILIAN_WORKSPACE_ID=llm-...
EOF
```

Never inline a real key in `agents.yaml`. The `.gitignore` entry written by `agents init` keeps `.env` out of version control.

> For Claude add `ANTHROPIC_API_KEY`, for Qoder add `QODER_PAT`, and for Volcengine Ark add `ARK_API_KEY`. The full provider field list is in [Provider reference](./reference/providers.md).

## Validate

```bash
agents validate
```

`validate` checks the YAML shape and field validity with no API calls. It fails fast on a missing `model`, an unknown resource type, or a `${VAR}` that is not resolvable.

## Plan

```bash
agents plan
```

`plan` refreshes remote state, compares your config against it, and prints the diff. On a fresh project everything is a create:

```text
$ agents plan

  + environment.dev        create
  + agent.assistant         create (depends: environment.dev)

  Plan: 0 to update, 2 to create, 0 to destroy.
```

Add `--provider <name>` to target a single provider, or `--json` for machine-readable output. See [CLI reference](./reference/cli.md) for the full option set.

## Apply

```bash
agents apply        # prompts for confirmation
agents apply -y     # skip the prompt
```

Resources are created in dependency order — the environment before the agent that uses it:

```text
$ agents apply -y

  ✓ environment.dev        created
  ✓ agent.assistant        created

  Apply complete. 2 resources managed.
```

## Run a session

A **session** is a runtime conversation started from a managed agent. `agents session run` creates a session, sends a prompt, and polls until the response completes. Add `--stream` to stream live events over SSE:

```bash
agents session run "Summarize the repo structure" --agent assistant
```

Other session commands: `session create`, `session list`, `session get`, `session send`, `session events`, `session delete`. See [Run sessions](./guides/run-sessions.md).

## Clean up

```bash
agents destroy
```

`destroy` removes every resource OpenAgentPack manages (skips dependents unless you pass `--cascade`).

## Next steps

- [Configure an agent](./guides/configure-an-agent.md) — environments, skills, vaults, MCP, multi-agent.
- [How it works](./architecture/how-it-works.md) — the three sources of truth and drift recovery.
- [Examples](./examples.md) — runnable configs indexed by goal.

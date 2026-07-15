# Multi-provider

Declare more than one provider in one config and the same agent definition deploys to each.

## Declare multiple providers

```yaml
version: "1"

providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"

defaults:
  provider: all
```

`defaults.provider: all` targets **every declared provider** from a single config. On any command you can override with `--provider <name>`.

## Per-provider model

When providers use different models, map them per provider instead of using a single string:

```yaml
agents:
  assistant:
    description: "Assistant deployed to both Claude and Qoder"
    model:
      claude: claude-sonnet-4-6
      qoder: ultimate
    instructions: |
      You are a helpful assistant.
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

A single string (`model: claude-sonnet-4-6`) is fine when every targeted provider accepts it; use the per-provider map when they differ.

## Plan and apply per provider

```bash
agents plan --provider claude     # only Claude's plan
agents plan --provider qoder      # only Qoder's plan
agents apply                       # all declared providers (defaults.provider: all)
agents apply --provider qoder      # apply Qoder only
```

## Portable config tips

- Write tool names **lowercase**; OpenAgentPack converts them to Qoder's PascalCase automatically.
- Resources can be pinned to one provider with a `provider:` field (e.g. a Qoder-only `memory_store`).

## Examples

- [`examples/claude/multi-provider/`](../../examples/claude/multi-provider/)
- [`examples/qoder/multi-provider/`](../../examples/qoder/multi-provider/)

# Provider reference

**English** | [简体中文](./providers.zh-CN.md)

OpenAgentPack targets multiple agent platforms behind one declarative config. Each platform is a **provider**. The same `agents.yaml` can deploy to any of them; capability differences are handled per provider.

## Capability matrix

| Feature | Bailian | Qoder | Claude | Volcengine Ark | Notes |
|---------|:-------:|:-----:|:------:|:--------------:|-------|
| Environment | native | native | native | native | All four providers expose cloud environments. |
| Vault | native | native | native | native | Bailian and Qoder manage credentials through their vault APIs. |
| Skill | native | native | native | native | Claude uploads via `files[]`; the other providers upload zip archives. Volcengine Ark is create + attach only. |
| Agent | native | native | native | native | Core managed-agent resource. |
| MCP Server | native | native | native | native | Bailian uses official managed servers referenced by name. |
| Memory Store | unsupported | native | unsupported | native | Available on Qoder and Volcengine Ark. |
| Multi-Agent | unsupported | unsupported | native | native | Coordinator topology is available on Claude and Volcengine Ark. |
| Deployment | emulated | emulated | native | emulated | Non-Claude providers expand a deployment into a session at `run` time. |
| Session | native | native | native | native | Runtime sessions are native on every provider. |

- **native** — the provider supports the feature directly.
- **emulated** — OpenAgentPack reproduces the behavior on top of primitives the provider does have.
- **unsupported** — declaring the feature for that provider is a validation error with remediation guidance.

This matrix is verified against the SDK capability declarations in `packages/sdk/src/internal/providers/*/capabilities.ts` by `scripts/provider-docs.test.ts`.

## Provider configuration

### Bailian (Aliyun AgentStudio)

```yaml
providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}
    # base_url is derived from workspace_id when omitted:
    # https://<workspace_id>.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio
```

### Qoder

```yaml
providers:
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"   # optional; this is the default
```

### Claude

```yaml
providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
    beta: "..."          # optional
```

### Volcengine Ark (Managed Agents)

```yaml
providers:
  ark:
    api_key: ${ARK_API_KEY}
```

## Tool naming differences

Built-in tools are always written lowercase in config. Bailian and Claude use lowercase natively; Qoder uses PascalCase. OpenAgentPack translates automatically when applying to Qoder.

| Function | Config (lowercase) | Qoder native |
|----------|--------------------|--------------|
| Read file | `read` | `Read` |
| Find files | `glob` | `Glob` |
| Search content | `grep` | `Grep` |
| Fetch web page | `web_fetch` | `WebFetch` |
| Web search | `web_search` | `WebSearch` |
| Write file | `write` | `Write` |
| Edit file | `edit` | `Edit` |
| Shell | `bash` | `Bash` |

## Targeting one or all providers

`defaults.provider` sets the default target. Set it to a single provider name, or to `all` to manage every declared provider from one config. On any command you can override with `--provider <name>`:

```bash
agents plan --provider claude
agents apply --provider qoder
```

## Multi-provider deployment

Declare more than one provider and the same agent can be deployed to each. See [`examples/claude/multi-provider/`](../../examples/claude/multi-provider/) for a multi-provider project, and the provider-specific directories under [`examples/`](../../examples/) for complete configurations.

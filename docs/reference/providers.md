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
| Memory Store | unsupported | native | unsupported | native | Qoder and Ark are implemented. Claude's upstream API now has Memory Stores, but its OpenAgentPack adapter does not yet. |
| Multi-Agent | unsupported | unsupported | native | native | Coordinator topology is available on Claude and Volcengine Ark. |
| Deployment | emulated | emulated | native | emulated | Non-Claude providers expand a deployment into a session at `run` time. |
| Session | native | native | native | native | Runtime sessions are native on every provider. |

- **native** — the provider supports the feature directly.
- **emulated** — OpenAgentPack reproduces the behavior on top of primitives the provider does have.
- **unsupported** — declaring the feature for that provider is a validation error with remediation guidance.

This matrix is verified against the SDK capability declarations in `packages/sdk/src/internal/providers/*/capabilities.ts` by `scripts/provider-docs.test.ts`.

## Adapter implementation matrix

The resource matrix above answers whether a declaration can be applied. The table below answers a different question: which optional workflows the **current OpenAgentPack adapter** actually implements. It is intentionally scoped to this repository, rather than every feature a provider may advertise.

| Adapter workflow | Bailian | Qoder | Claude | Volcengine Ark | Implementation notes |
|------------------|:-------:|:-----:|:------:|:--------------:|----------------------|
| List agents, environments, and vaults | yes | yes | yes | yes | Powers resource discovery in the Web UI. |
| Export resources to YAML (`sync`) | yes | yes | yes | limited | Ark cannot enumerate skills, so skill export is skipped. |
| Full drift comparison | Environment, Agent | Environment, Agent | no | no | Other supported resources degrade to existence checks; emulated deployments are local state. |
| List uploaded files | yes | yes | yes | yes | File upload, metadata lookup, and deletion are also implemented by all adapters. |
| Resolve artifact download URL | no | yes | no | no | Qoder exposes a short-lived file content URL. |
| List skills | yes | yes | yes | no | Ark supports lookup by ID, but its adapter cannot enumerate skills. |
| Download skill source during `sync` | no | no | yes | no | Only Claude currently materializes remote skill packages locally. |
| Non-blocking skill creation for Web UI polling | yes | no | no | no | Bailian can create from an uploaded file ID and let the UI poll scan status. |
| List provider models | no | yes | yes | no | Used for model selection where a provider exposes a model catalog. |
| Stream and page session events | yes | yes | yes | yes | All adapters normalize provider events to the shared session event shape. |
| Resume event stream from send cursor | no | yes | no | no | Qoder returns an event cursor; the others connect before sending to avoid missed events. |

`yes` means the corresponding optional `ProviderAdapter` facet is implemented. `no` means OpenAgentPack currently soft-degrades that workflow; it does not necessarily mean the upstream platform can never support it. `limited` means the workflow is implemented with the restriction described in the notes.

### Notable provider-specific behavior

- **Bailian:** skill upload uses the Files API and supports scan-status polling; agent updates create provider-side versions. Official MCP servers are referenced by name.
- **Qoder:** tool names are translated from the lowercase config vocabulary to PascalCase. Session sends return a cursor, enabling resumable event consumption. `system.message` is flattened to `user.message` when running an emulated deployment.
- **Claude:** deployments are native, including their server-side lifecycle. It is currently the only adapter that downloads remote skill packages during `sync`.
- **Volcengine Ark:** skills are create + get + attach only in the API behavior verified by this project. Updates re-upload a new skill; list and in-place update are unavailable; deletion is best-effort. Deployment is emulated as a session.

### Claude and Volcengine Ark research notes

Last reviewed: **2026-07-17**. The evidence labels below deliberately separate upstream product capability from OpenAgentPack support.

| Area | Claude Managed Agents (official) | Claude adapter | Volcengine Ark (official/public) | Ark adapter |
|------|----------------------------------|----------------|-------------------------------|-------------|
| API status and protocol | Direct Claude API is GA for Messages/Models; Managed Agents, Files, and Skills are beta and require `managed-agents-2026-04-01` where applicable | Sends that beta header to `api.anthropic.com/v1` | Official Managed Agents API under `/api/v3`, authenticated with a Bearer API Key | Uses the documented base URL and wire shapes |
| Stateful sessions | Server-side history, sandbox state, event send/stream, interruption, and resume | Create/list/get/delete, send, SSE stream, and paged event history | Official APIs cover session CRUD, event send/list/stream, resources, and multi-agent threads | Create/list/get/delete, send, SSE stream, and paged event history; session update/resources/threads are not exposed |
| Environment | Isolated cloud sandbox per session; reusable environment config, package cache, and network policy | CRUD and list implemented | Official create/list/get/update/delete endpoints | CRUD/list implemented and existence drift checked |
| Skills | Built-in Anthropic skills plus custom zip or individual-file uploads; max 20 per session | CRUD/list/get/download implemented; adapter uploads `files[]` | Official documentation currently lists create and get only | Create/get/attach implemented; update recreates; list/delete are unavailable upstream |
| Multi-agent | Coordinator delegates to persistent, context-isolated threads sharing sandbox/files/vaults | Coordinator topology implemented | Agent schema includes `multiagent`; Session APIs expose thread list/detail/events/stream | Coordinator topology implemented; thread inspection is not exposed through `ProviderAdapter` |
| Deployment | Native scheduled deployments with cron/timezone and run history | Native lifecycle and run implemented | The official Managed Agents API catalog contains no Deployment resource | Emulated locally and expanded into a Session at run time |
| Memory Store | Official API supports persistent, versioned memories mounted read-only or read-write; up to 8 stores per session | **Gap:** not implemented, so capability remains `unsupported` in OpenAgentPack | Official CRUD for stores plus create/batch-create/list/get/update/delete for memories | Store create/delete and Session binding implemented; list/get/update and memory-content operations are adapter gaps |

Primary references: [Claude API overview](https://platform.claude.com/docs/en/api/overview), [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [sessions and event streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming), [skills](https://platform.claude.com/docs/en/managed-agents/skills), [multi-agent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent), [scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments), [memory stores](https://platform.claude.com/docs/en/managed-agents/memory), and the [Volcengine Ark Managed Agents API reference](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2555910?lang=zh).

The Ark API catalog confirms an important distinction for maintainers: some upstream operations are not yet represented in `ProviderAdapter` (session update/resources/threads, vault update and credential lifecycle, full Memory Store operations), while the narrow Skill lifecycle is an upstream limitation rather than merely missing adapter work.

### Keeping this table current

When adding a provider or optional adapter method:

1. Update its `capabilities.ts` for resource-level support and implement the required lifecycle methods.
2. Re-check optional methods in `ProviderAdapter` (listing, sync/export, drift, files, skills, models, and session-event resume) and update this matrix.
3. Record API limitations in adapter comments with the endpoint or observed behavior; distinguish upstream limitations from missing OpenAgentPack work.
4. Run `bun test scripts/provider-docs.test.ts`. The test verifies both the resource matrix and the optional-method rows against adapter prototypes.

### Provider documentation index

Use these links as the starting point when refreshing the capability matrix or adding a provider method. Prefer official product/API pages over inferred behavior from this repository.

| Provider | Primary source | Useful follow-up sources | Notes |
|----------|----------------|--------------------------|-------|
| Bailian | [Managed Agents quickstart](https://help.aliyun.com/zh/model-studio/managed-agents-quick-start) | [Model Studio docs root](https://www.alibabacloud.com/help/zh/model-studio/), [single-agent application guide](https://help.aliyun.com/zh/model-studio/single-agent-application) | Managed Agents quickstart shows the `/api/v1/agentstudio` endpoint family used by this adapter. |
| Qoder | [Cloud Agents API overview](https://docs.qoder.com/cloud-agents/api/conventions/overview) | [Cloud Agents overview](https://docs.qoder.com/cloud-agents/overview), [Agent Skills](https://docs.qoder.com/cloud-agents/skills), [Cloud Agents marketplace skill](https://qoder.com/marketplace/skill?id=official_FjWvobU0) | API docs are the canonical source for gateway URL, headers, resources, pagination, and event streaming. |
| Claude | [Claude API overview](https://platform.claude.com/docs/en/api/overview) | [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [events and streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming), [skills](https://platform.claude.com/docs/en/managed-agents/skills), [multi-agent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent), [scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments), [memory stores](https://platform.claude.com/docs/en/managed-agents/memory) | API overview gives GA/beta status; Managed Agents pages give resource-specific behavior. |
| Volcengine Ark | [Managed Agents API reference](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2555910?lang=zh) | [Ark documentation center](https://docs.volcengine.com/docs/82379), [API key management](https://www.volcengine.com/docs/6257/64983?lang=en) | The console API reference is the source for `/api/v3` resources and confirms that Deployment is not a first-class resource. |

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

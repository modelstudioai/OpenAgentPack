# @openagentpack/sdk

## 0.10.0

### Minor Changes

- 3df5c92: 为百炼多智能体名册增加原生 `{type: "self"}` 成员，可独立使用或与项目 Agent、外部 Agent 混用。
  补齐声明类型与严格校验、引用解析、发布映射、导出和漂移比较。Self 不生成普通自引用或额外受管资源，
  计入名册上限并禁止重复及附带 ID/版本字段；其他 Provider 明确拒绝未验证的 Self 能力。
- 3df5c92: Add native Bailian Memory Store, memory file, and historical version APIs, including store archive, file rename, content SHA preconditions, version redaction, and opaque `page`/`next_page` pagination. Preserve native absolute paths, response fields, operation names, and service errors.

  Enable declarative Bailian Memory Stores with ID-only identity, explicit import, declared-key metadata reconciliation, and recoverable initialization. Persist the created store ID and pending initializer hashes before writing content; retries resume missing pending paths without overwriting existing files. Existing and imported stores preserve runtime content by default, while explicit `entries_mode: sync` manages declared paths. Removing a store and applying, or destroying it, irreversibly archives it.

  Resolve logical Memory references into native Session resources with access settings, instructions, deduplication, and an eight-store limit. Block Session mounting until initialization completes and reject Memory mounts in file-only Bailian Deployments.

- 3df5c92: 为百炼 BMA Session 增加显式开启的结构化事件快照和正文/推理增量订阅。SDK 按消息与内容块
  归并累计快照，保留工具调用、线程、审批、错误和多模态内容；从已确认的 `mark_artifacts`
  工具结果派生文件描述，继续复用现有 `SessionEvent` 契约。

  补齐 SSE 分块解析、连接就绪回调、取消、超时及可选的断流后历史核对恢复。高层发送入口
  通过 `stream` 传递配置，恢复不会重发用户消息。sanitizer 支持结构化快照的递归脱敏和按文本
  叶子截断。旧调用仍使用 legacy 输出，默认脱敏和截断、默认不重连的行为保持不变。

- 3df5c92: 为百炼 Managed Agents 增加会话运行时资源 API（挂载/列出/查详情/卸载），支持向已创建的
  Session 动态追加文件：`mountRemoteSessionResource`、`listRemoteSessionResources`、
  `getRemoteSessionResource`、`unmountRemoteSessionResource`（bailian adapter 的
  `mountSessionResource` / `listSessionResources` / `getSessionResource` / `unmountSessionResource`
  可选方法）。中性层沿用全沙箱路径（`/mnt/session/uploads/…`），bailian wire 自动换算为运行时
  端点要求的 `/uploads/…` 前缀并在非法根路径上客户端拒绝；资源响应补齐 `SessionResourceInfo.id`
  （`sesrsc_…`，卸载凭据）。挂载与卸载不产生会话事件；provider 返回的 `file_id` 是服务端内部副本
  id，完整载荷保留在 `attributes` 中。运行时挂载不进入 `getSession` 的 `resources` 回显，对账请
  使用列表端点。合同经 2026-11-02 live 实测校准。

  上述四个 SDK 入口接受仅含 Provider 配置的 `ManagedApiContext`，无需项目配置或本地 State；
  现有 `ProjectRuntimeContext` 调用保持兼容。

- 3df5c92: 新增百炼资源用量查询：`listModelUsage` / `listToolUsage` 对接 app-control `usage.listModelUsage` / `usage.listToolUsage`，支持 workspace/agent/session 三种 scope、毫秒级 time_range 交叉校验（session 禁止、其余必传）、来源与名称过滤及分页排序，并公开 `UsageScope`、`ModelUsagePage`、`ToolUsagePage` 等类型。apps/server 同步暴露 `POST /api/usage/models`、`POST /api/usage/tools` 并刷新 OpenAPI 快照。
- 3df5c92: 新增浏览器安全的 `createBailianSessionEventNormalizer`，从 `@openagentpack/sdk/session-events`
  接收原始百炼业务帧并输出累计 `SessionEvent`。历史进行中消息保留展示及运行身份，等待完整快照
  后恢复正文；完成消息保护、按实例隔离和有界缓存避免重连期间重复追加。既有 SDK 入口与
  sanitizer 默认脱敏、截断行为不变。

  同一浏览器子路径公开导出现有 `SessionEvent` 类型，纯浏览器调用方无需通过 SDK Node 主入口引用事件契约。

- 3df5c92: 为 `sanitizeSessionEvent()` 和 `sanitizeSessionEvents()` 增加独立的 `redact` 与 `truncate`
  配置，保留默认开启脱敏和截断的行为。需要完整 SSE 内容的调用方可显式传入
  `{ redact: false, truncate: false }`。导出 `SessionEventSanitizerOptions` 类型，
  让 `metadata.tool_input` 使用同一脱敏策略，并保持 `includeRaw` 独立。
- 3df5c92: 新增对象声明的字面正文解析选项与公开内存 state 管理器，支持宿主使用数据库保存检查点。默认正文文件解析、文件 state 和现有发布行为保持兼容。
- 3df5c92: Default declarative memory entries to initialization of newly created stores only. Existing, imported, or adopted stores retain their runtime content, and initialization-only entry changes no longer schedule updates. Add entries_mode: sync as an explicit opt-in to the previous continuous YAML synchronization behavior.
- 3df5c92: 新增百炼 Session 子 Agent 线程列表和事件历史查询，保留分页、取消及完整快照语义，并公开浏览器可用的线程类型。
- 3df5c92: Add workspace-level Bailian Webhook endpoint management and delivery-event queries through a provider-only API context. Expose endpoint URL normalization and cancellable requests while preserving one-time signing-secret responses, opaque pagination cursors, request IDs, and provider errors. These APIs do not read project files or write project state.

### Patch Changes

- 3df5c92: Support Bailian builtin-tool approval policies during validation and Agent create/update. Preserve toolkit defaults and per-tool overrides in provider requests and exports, detect effective approval changes during drift comparison, and retain legacy allow-only comparison baselines. Reject effective approval policies on project-declared subagents and delegated Self; fail closed when an implicitly enabled remote tool catalogue cannot be exported losslessly.
- 3df5c92: Identify Bailian Memory Stores by their remote ID rather than their non-unique display name. Disable name-based conflict adoption, create a new store when no remote ID is recorded, and exclude archived stores from ID-based lifecycle lookups.
- 3df5c92: 修复百炼 BMA Session 混合流中 event_start/event_delta 的身份及正文累积，避免首个推理分片触发协议错误；保留完整消息、线程身份和断流恢复语义。
- 3df5c92: 修复会话文本处理中的两处正则回溯风险，使用线性扫描识别 Markdown 链接和 HTML 标签，保留媒体签名链接、敏感信息脱敏与截断边界的既有行为。
- 3df5c92: Allow MCP toolkit configs and agent-builder tool overrides to be omitted or empty. Bailian requests normalize missing overrides to an empty array, so default_config.enabled can enable all MCP tools without placeholder names. Preserve the disabled default and explicit per-tool overrides.
- 3df5c92: 修复百炼 Session 重连时历史结束状态抢先终止单轮读取的问题，确保恢复期间缓冲的完整回复先交付。
  修复结构化资源执行在 StateBackend 最终提交失败时丢失报告的问题，保留远端写入状态、逐资源结果和已知资源 ID，legacy 异常行为保持兼容。

  将 Playground 的 `@hono/node-server` 最低版本升级至 `2.1.6`，修复上游 WebSocket 连接重置和请求路径解析问题。

- 3df5c92: 将 Zod 依赖下界更新为 4.6.6，修复 GHSA-mrhx-c7xc-m3w5，避免新安装解析到受影响版本。

## 0.9.0

### Minor Changes

- 9390e7b: Add native Bailian Memory Store, memory file, and historical version APIs, including store archive, file rename, content SHA preconditions, version redaction, and opaque `page`/`next_page` pagination. Preserve native absolute paths, response fields, operation names, and service errors.

  Enable declarative Bailian Memory Stores with ID-only identity, explicit import, declared-key metadata reconciliation, and recoverable initialization. Persist the created store ID and pending initializer hashes before writing content; retries resume missing pending paths without overwriting existing files. Existing and imported stores preserve runtime content by default, while explicit `entries_mode: sync` manages declared paths. Removing a store and applying, or destroying it, irreversibly archives it.

  Resolve logical Memory references into native Session resources with access settings, instructions, deduplication, and an eight-store limit. Block Session mounting until initialization completes and reject Memory mounts in file-only Bailian Deployments.

- 9390e7b: Default declarative memory entries to initialization of newly created stores only. Existing, imported, or adopted stores retain their runtime content, and initialization-only entry changes no longer schedule updates. Add entries_mode: sync as an explicit opt-in to the previous continuous YAML synchronization behavior.
- 9390e7b: Add workspace-level Bailian Webhook endpoint management and delivery-event queries through a provider-only API context. Expose endpoint URL normalization and cancellable requests while preserving one-time signing-secret responses, opaque pagination cursors, request IDs, and provider errors. These APIs do not read project files or write project state.

### Patch Changes

- 9390e7b: Identify Bailian Memory Stores by their remote ID rather than their non-unique display name. Disable name-based conflict adoption, create a new store when no remote ID is recorded, and exclude archived stores from ID-based lifecycle lookups.
- 9390e7b: Use the actual creation name when looking up a memory store after a creation conflict, preventing adoption of a different store named after the configuration key.
- 9390e7b: Allow MCP toolkit configs and agent-builder tool overrides to be omitted or empty. Bailian requests normalize missing overrides to an empty array, so default_config.enabled can enable all MCP tools without placeholder names. Preserve the disabled default and explicit per-tool overrides.
- 9390e7b: Preserve YAML anchors when redacting environment variable values so valid aliases remain usable in version previews and version snapshot checks. Stored and restored configuration retains its original values.

## 0.8.0

### Minor Changes

- 3823078: Add Multi-Agent coordinator support for Qoder (Managed Agents and Forward Templates) and Bailian Managed Agents. `multiagent.agents` accepts project logical names plus explicit external Managed Agent references (`{ agent_id }`), validates the phase-1 topology (no self/nesting/cycles, max 20 members, Qoder members share the coordinator's delivery type), maps members to `id` or `template_id` wire references, clears rosters via `multiagent: null` or an empty array, compares multi-agent drift semantically, and exports remote coordinators back to logical names or stable external references. External members are not lifecycle-managed, and Qoder Forward rejects `{ agent_id }` because its roster requires Template ids.

## 0.7.3

### Patch Changes

- bc4edea: Clear stale Bailian and Qoder agent skill bindings when the last declared skill is removed.

## 0.7.2

### Patch Changes

- fd62da0: Fix Qoder managed resource identity matching during drift detection by passing declarations to comparable reads and matching on protected metadata.

## 0.7.1

### Patch Changes

- Automatically associate active Agent-local resources during Build while preserving explicit bindings, Skill versions, and File mount paths. Reject ambiguous Environment or Vault selections before writing, and report actionable project-root hints when commands run from a nested directory.

## 0.7.0

### Minor Changes

- Include local versions and directory project services in the SDK through the Node-only `./project-versions` and `./project-workspace` exports. Preserve existing snapshots, resource layouts, and shared runtime behavior while removing the two standalone package publication requirements.

## 0.6.0

### Minor Changes

- 8c6a767: Replace the fixed Playbook showcase with project-aware debugging. `agents playground` remains a read-only `agents.yaml` Session Preview, while `agents project workbench` watches and edits a directory project, performs fingerprint-protected Build/Plan/Publish operations, streams operation and Session events, and manages explicit temporary attachment cleanup.

  Add SDK source-path tracking, runtime-scoped Agent planning, full-project planning, stable plan fingerprints, and stale-plan enforcement. Preview stays at `agents playground -f/--file [--agent <id>]`; the project console moves under `agents project workbench --project <directory>`.

- f956bad: Publish a directory workspace service for deterministic Build/Publish and a
  Git-independent full source-tree snapshot engine. CLI and Workbench share one
  versioning switch, content-addressed text/binary blobs, forward restore, and a
  cross-process mutation lock while remote State remains excluded. Project Build
  previews now show full directory source changes against the current version HEAD.

## 0.5.0

### Minor Changes

- 8b0718d: Expose Bailian Managed Agents operation-level reads, cursor pagination, session events, file downloads, deployment actions, provider capability metadata, generic scoped create-only planning/apply, local Skill source inspection, scoped Vault Credential creation, and display names independent from logical YAML keys.

## 0.4.0

### Minor Changes

- 407cc75: Add `mode: pairing` support for Qoder Channels.

  `channels[].mode` now accepts `fixed` (default) or `pairing`. Pairing-mode channels create a transport-only IM connection without binding to an Identity or Template, which is required for Forward Schedule sinks such as scheduled group broadcasts. Fixed-mode channels retain the existing behavior and continue to require `agent` and `identity`.

## 0.3.2

### Patch Changes

- e74f023: Bailian: implement native Deployment support against the Agent Studio `/deployments` API (create, get, list, update, archive, run, pause/unpause), replacing the previous emulated session expansion. Deployment schedules now run server-side; `user.define_outcome` events and `github_repository` resources are dropped from the deployment payload and surface a warning on plan.

## 0.3.1

### Patch Changes

- 32778d4: Lower the SDK `engines` floor from Node `>=22` to `>=18.17.0`.

  The SDK runtime only relies on APIs available since Node 18.17 (`node:fs`/`path`/`crypto`/`os`, global `fetch`/`FormData`, `structuredClone`, web streams), so the previous floor was a repository baseline rather than a runtime requirement. The tsup build target is pinned to `es2022` so emitted syntax stays parseable on the new floor, and CI now runs an SDK-only packed-install smoke on Node 18 and 20 (`smoke-packed.ts --sdk-only`) to enforce the contract. The `@openagentpack/cli` and `@openagentpack/playground` packages keep their Node `>=22` requirement.

## 0.3.0

### Minor Changes

- 24e5370: Add a portable Memory Store and Memory lifecycle API across Qoder, Claude, and
  Volcengine Ark, including provider capability differences, CLI commands,
  declarative entry reconciliation, version history, and Ark batch creation.

## 0.2.0

### Minor Changes

- fd1cf3b: Add BYOC runtime, session, vault, and Qoder deployment capabilities, including native deployments, tunnels, and forward templates.

## 0.1.1

### Patch Changes

- ba1af83: Classify Agent readiness from structured plan impact and changed paths instead of parsing display text.

## 0.1.0

### Minor Changes

- 06f8527: Require maintained Node.js releases (22 or newer) and certify published packages on Linux, Windows, and macOS before creating a GitHub Release.

## 0.0.2

### Patch Changes

- 86c1ff1: release 0.0.1

## 0.0.2-beta.0

### Patch Changes

- release 0.0.1

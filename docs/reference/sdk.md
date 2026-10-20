# SDK reference

`@openagentpack/sdk` is the Node-compatible TypeScript project/runtime SDK that powers the `agents` CLI. The same package exports Node-only local snapshots from `@openagentpack/sdk/project-versions` and directory Build/Publish services from `@openagentpack/sdk/project-workspace`. These subpaths share the SDK's validation, transport, and error types without adding project services to the default entry. See [directory projects](../../packages/sdk/docs/project-workspace.md), [local versions](../../packages/sdk/docs/project-versions.md), and the [public API contract](../../packages/sdk/docs/public-api-layers.md).

## Install

```sh
npm install @openagentpack/sdk
```

## Quick example

```ts
import { resolveProjectConfig, planProjectContext } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

## API layers

The package entry is `.`. It also exposes three narrow, browser-safe subpath contracts:

- `./session-events` — session event streaming/parsing (browser-safe).
- `./scan-lifecycle` — scan lifecycle helpers.
- `./file-lifecycle` — file lifecycle helpers.

Everything re-exported from these entries is public SDK surface. The engine itself lives under `src/internal/` and is deliberately not reachable from outside the package — there is no `exports` condition that resolves into it.

## Session 事件内容策略

`@openagentpack/sdk/session-events` 导出的 `sanitizeSessionEvent()` 和
`sanitizeSessionEvents()` 接受同一个 `SessionEventSanitizerOptions` 配置。
SDK 保持默认脱敏、默认截断；完整 SSE 的调用方可以显式关闭这两种处理：

```ts
import {
  sanitizeSessionEvent,
  sanitizeSessionEvents,
  type SessionEventSanitizerOptions,
} from "@openagentpack/sdk/session-events";

sanitizeSessionEvent(event); // 保持默认脱敏和截断
sanitizeSessionEvent(event, { redact: false }); // 仅关闭脱敏
sanitizeSessionEvent(event, { truncate: false }); // 仅关闭截断
const completeContent: SessionEventSanitizerOptions = { redact: false, truncate: false };
sanitizeSessionEvent(event, completeContent); // 完整 SSE 内容的显式策略
sanitizeSessionEvents(events, { ...completeContent, includeRaw: true });
```

- `redact` 默认 `true`，控制正文、错误文本、`metadata.tool_input` 和可选
  `metadata.raw` 中的敏感文本替换；仅影响本次调用，不改变全局配置。
- `truncate` 默认 `true`，保留原有上限：普通正文 4000 字符、工具正文 8000 字符、
  检出的 HTML/SVG/Mermaid 文档 32000 字符、可选 raw 16000 字符。
  只有显式传入 `false` 才取消这些长度限制。旧 `legacy` 投影中的
  `metadata.tool_input` 保持原有长度；新 `snapshot` 模式中的工具参数按工具文本上限处理。
- 两个开关互相独立，同时开启时先脱敏再截断。`metadata.redacted` 和
  `metadata.truncated` 仅在对应处理实际改变数据时设置为 `true`。
- `includeRaw` 默认 `false`，独立控制是否包含 Provider 原始数据；开启后同样遵循
  两个策略。关闭脱敏和截断不会自动返回 raw。
- 脱敏沿用关键词和 URL 参数匹配规则，Markdown 媒体及下载链接的保留规则不变。
  新 `snapshot` 路径还识别结构化对象中的 `api_key`、`authorization`、`secret`、
  `token` 等敏感字段，但不承诺识别任意业务敏感信息。
- 存在 `ProviderSessionEvent.snapshot` 时，sanitizer 优先深拷贝该结构，递归处理文本叶子，
  保留对象、数组、身份、状态和内容块索引。截断不会把整个对象变成残缺的 JSON 字符串。
  显式 `content: []` 不会被旧的正文便利字段重新填充。
  身份字段的豁免只适用于协议中的明确位置；工具参数、输出及未知业务数据内同名的
  `code`、`id`、`status` 等字段仍按所选策略脱敏和截断，包括 `metadata.tool_input` 与可选 raw。
- 仅关闭内容策略不会开启增量或补齐旧 `legacy` 投影；需要结构化内容时同时选择
  下文的 `snapshot` 模式。
- `streamSessionEvents()` 和 `listSessionEvents()` 返回 `ProviderSessionEvent`；
  内容策略在转换为契约 `SessionEvent` 时传入，不是 Provider 请求参数。

## 百炼 Session SSE 与累计快照

此能力针对百炼 BMA Session 的 `/sessions/{session_id}/events/stream` 协议。
SSE 是传输方式；`event_deltas` 决定是否订阅消息生成期间的正文和推理分片。
本能力不解析 CMA 的 `event_start/event_delta` 或 Responses API 的流式格式。

### 默认行为与显式选项

旧调用不传新选项时仍使用 `event_format: "legacy"`：不请求增量，不新增累计快照，
`ProviderSessionEvent` 的原有便利字段与 sanitizer 默认策略保持不变。
`event_format: "snapshot"` 可用于完整事件流或历史查询，不要求同时开启增量。

| 选项 | 适用入口 | 默认与含义 |
| --- | --- | --- |
| `event_format` | 历史、流式 | `"legacy"`；设置 `"snapshot"` 保留结构化事件 |
| `event_deltas` | 流式 | 不传；非空 `("message" \| "reasoning")[]` 请求相应内容分片，自动选择 `snapshot` |
| `signal` | 历史、流式 | 不传；取消请求、流读取及恢复等待 |
| `onReady` | 流式 | 不传；每次 HTTP 连接成功且 reader 建立后调用 |
| `reconnect` | 流式 | `false`；仅百炼 `snapshot` 模式支持自动恢复 |
| `connectTimeoutMs` | 流式 | `snapshot` 默认 30000 毫秒；连接就绪前超时 |
| `idleTimeoutMs` | 流式 | `snapshot` 默认 180000 毫秒；任何网络数据、注释和心跳均计为活动 |

显式 `event_format: "legacy"` 与非空 `event_deltas` 冲突时直接报错。
非百炼 Provider 请求快照、增量或这些流生命周期配置时明确报不支持，不会静默忽略。
超时必须是正的有限数值。`event_deltas` 才会编码为百炼的 `event_deltas[]` 查询参数，
其余新选项由 SDK 本地处理。

`streamSessionEvents()` 的流选项直接放在第三个参数中；
`startSessionRun()` 和 `sendSessionMessageStreaming()` 则放在 `options.stream` 中：

```ts
import {
  sendSessionMessageStreaming,
  streamSessionEvents,
  type ProjectRuntimeContext,
  type SessionEvent,
} from "@openagentpack/sdk";
import { sanitizeSessionEvent } from "@openagentpack/sdk/session-events";

// ctx 使用调用方已经配置好的百炼 runtime；本函数只订阅，不发送用户消息。
async function watchSession(
  ctx: ProjectRuntimeContext,
  sessionId: string,
  signal: AbortSignal,
  onEvent: (event: SessionEvent) => void,
) {
  for await (const event of streamSessionEvents(ctx, sessionId, {
    provider: "bailian",
    event_deltas: ["message", "reasoning"], // 自动选择 snapshot
    signal,
    reconnect: true, // 默认关闭；此例显式开启
    onReady: () => console.info("SSE connection established"),
  })) {
    onEvent(sanitizeSessionEvent(event, { redact: false, truncate: false }));
  }
}

// 高层发送入口负责先建立订阅，再发送一次消息。
async function sendMessage(ctx: ProjectRuntimeContext, sessionId: string, signal: AbortSignal) {
  return sendSessionMessageStreaming(ctx, sessionId, "请介绍一下这个项目", {
    provider: "bailian",
    stream: { event_deltas: ["message", "reasoning"], signal },
  });
}
```

高层发送返回的事件迭代器也需要使用 `for await` 消费，才能驱动订阅和发送。
`onReady` 表示客户端 HTTP 连接及 reader 已建立，不代表首个业务事件已到达，
也不额外保证服务端已将订阅登记到它的执行系统。

### 快照内容与消费方式

新模式每次输出的 `ProviderSessionEvent.snapshot` 都使用现有 `SessionEvent` 契约。
分片累计后的正文可能依次为 `你`、`你好`、`你好！`，它们沿用同一个 `event_id`。
调用方应按 ID **替换同一条消息的快照**，不能把每次快照当作新消息追加，也不能按 ID
只保留第一次结果。无 ID 的状态事件仍应独立处理。

- `content[]` 保留正文、推理、工具数据、多模态和未知内容块；`delta: true` 追加到
  对应索引，`delta: false` 替换该块。最终消息显式携带的 `content` 具有权威性。
  空字符串或 `content: []` 表示清空，字段缺失表示保留已有值。
- `metadata.event_status` 是消息生命周期，如 `in_progress/completed`；
  `metadata.status` 是会话运行状态，如 `running/idle`，两者不能互相替代。
- 工具调用通过 `call_id` 关联，保留参数和输出的字符串或对象形态、错误标记、MCP 信息；
  线程路由、结构化停止原因与审批字段保留到内容或元数据中。
  SDK 不会自动批准工具调用，也不会把不同审批字段改写成同一种协议。
- **`metadata.artifacts[]` 是 SDK 派生字段，不是 SSE 原生字段**：SDK 仅在工具名或
  `call_id` 关联确认是 `mark_artifacts` 结果后，从 `output.marked[]` 提取有效文件。
  原始 `marked/failed` 结果仍保留在内容里；首个文件同时提供 `metadata.artifact`。
  SDK 不从普通文本猜测产物，也不自动获取下载 URL。
- 每次快照都是独立对象，后续分片不会修改已交付的快照。
  `ProviderSessionEvent.raw` 始终是实际触发该次输出的上游帧，不是伪造的累计帧。
  sanitizer 仅在 `includeRaw: true` 时将它放进 `metadata.raw`。

历史查询同样显式选择 `snapshot`，分页继续使用 Provider 返回的不透明 `next_page`：

```ts
import { listSessionEvents } from "@openagentpack/sdk";
import { sanitizeSessionEvents, toBailianSessionEvent } from "@openagentpack/sdk/session-events";

const page = await listSessionEvents(ctx, sessionId, {
  provider: "bailian",
  event_format: "snapshot",
  order: "asc",
  limit: 100,
  page_token: previousNextPage,
});
const events = sanitizeSessionEvents(page.events, { redact: false, truncate: false });

// 纯映射函数用于完整消息/历史事件；content 分片必须经过订阅内的有状态归并器。
const mapped = toBailianSessionEvent(rawCompleteEvent, { event_format: "snapshot" });
```

其中 `ctx`、`sessionId`、上一页的 `previousNextPage` 和原始完整事件由调用方提供。
`./session-events` 子路径保持浏览器安全，提供纯映射、累计转换与 sanitizer；
网络订阅和高层 Session 工作流使用 SDK 主入口，不应导入 `internal/*`。

### 自建后端原始事件的浏览器转换

自建后端透传百炼 SSE 时，调用方负责 HTTP、SSE 解帧、订阅就绪、历史分页与重试。
纯转换入口只接受已经解析的百炼业务 JSON，不接受心跳、SSE `event/data/id` 文本或 Kit 控制帧：

```ts
import { createBailianSessionEventNormalizer } from "@openagentpack/sdk/session-events";

const normalizer = createBailianSessionEventNormalizer({
  redact: false,
  truncate: false,
  maxEntries: 1024,
});

// 按顺序输入历史；然后输入已缓冲的实时业务帧。
const historySnapshot = normalizer.seed(rawHistoricalEvent);
const liveSnapshot = normalizer.push(rawLiveFrame);
// 输出可能为 undefined；有输出时按 event_id 替换累计快照。
// 重连重建或更换 Session 前清空，不能沿用未完成正文当新 delta 基线。
normalizer.clear();
```

`rawHistoricalEvent` 和 `rawLiveFrame` 均由调用方提供。每个逻辑订阅独立创建实例；
两个方法都直接返回 `SessionEvent | undefined`，无需再次调用 sanitizer。选项沿用
`SessionEventSanitizerOptions`：默认脱敏、截断，默认不附加 `metadata.raw`。

- `seed` 区分 `in_progress` 和完成历史。未完成快照保留正文、消息身份、线程及运行状态供展示，
  但正文不成为后续 delta 的追加基线；后续局部分片及进行中快照被抑制，直到完成消息显式给出
  整体 `content`。单个 `delta: false` 内容块不足以证明其他块完整。缺少最终正文会报协议错误。
- 已完成的历史 message/reasoning 在本次重建中保护同 ID 正文，避免旧缓冲帧覆盖；
  session_status 和工具事件仍允许同 ID 的完整状态更新。转换器不能推断跨事件的新旧顺序，
  调用方必须对历史与缓冲流建立可验证的交接边界。
- `maxEntries` 默认 1024，限制保留的事件身份、孤立分片数量及单条消息的内容块数量。已输入的历史身份保留到
  `clear()`；超过限制明确报错，不静默丢弃历史保护。调用方还应限制输入字节数、历史总量、
  建连/空闲时间并在失败或取消后清理实例。不同连接的去重和重试不属于该纯转换接口。
- 浏览器只访问业务后端，不需要也不应取得百炼凭据。这个入口不改变 SDK 主入口的
  `legacy/snapshot` 默认行为，也不自动打开网络、发送消息或执行审批。

### 断流恢复、结束与取消

`reconnect: true` 在意外 EOF、网络故障、429 或 5xx 后最多重试 3 次，等待时间依次为
250、500、1000 毫秒。鉴权、参数和协议错误直接失败。主动取消不会重连。
`snapshot` 模式将意外 EOF 作为断流错误，不把它合成为业务完成事件；旧模式保留原有行为。

恢复时先建立新订阅并缓冲实时帧，再按升序分页查询历史，归并完成事件后继续处理实时数据。
它只恢复订阅，**不会重新发送用户消息或启动新的 Agent 执行**。
已交付事件的同 ID 变化快照仍会更新调用方，不因位于恢复标记或其之前而丢弃；
恢复得到的本轮结束状态在历史消息修复完成后交付，避免提前结束而遗漏最终答案。
百炼没有在本 SDK 中确认的原生逐分片续传合同，`after_id` 在快照模式中作为本地历史核对
标记，不作为原生游标发送给百炼；旧模式的历史轮询回退保持不变。
在旧模式同时传入 `after_id` 和 `signal`、`onReady` 或超时配置会明确报错；需要这些控制时使用快照模式。

恢复目标是最终消息收敛，无法保证断开期间每个 token 都恰好重放一次。SDK 不会盲目把
重连后的分片追加到断开前的半截内容；缺少可靠基线时等待最终快照或历史完成事件。
缺失历史标记、重复分页游标、耗尽重试或缓冲超过 1024 帧/8 MiB 会明确报错，不静默丢内容。

单条消息完成不等于整个 Session 流结束。直接订阅保持持续接收；单轮发送入口根据会话状态
结束本轮消费。调用对应的 `AbortController.abort()` 会取消读取及恢复工作，退出迭代器也会释放连接。
发送请求尚未返回时取消会停止 SDK 的等待，但不表示 Provider 已取消执行，也不会重新发送消息。

此接口描述不表示已发布到 npm。协议 fixture、字节分块及模拟 HTTP 测试验证 SDK 行为，
不构成真实 Cloud SSE 或已安装下游版本的验证结果。

## Service APIs

The public entry exposes domain workflows that return structured domain results (sessions, plans, diagnostics, resources, provider-neutral metadata). It does **not** return terminal rows, React view models, HTTP envelopes, SSE wrappers, or localized strings.

| Area | Functions |
|------|-----------|
| Project / resource workflows | `resolveProjectConfig`, `resolveProjectConfigFromObject`, `planProjectContext`, `executePlannedProject`, `decideDestructive`, `importResource`, `syncProjectResourcesWithStateBackend` |
| Validation and safe source previews | `validateProjectConfig`, `collectConfigReferences`, `inspectProjectSource` |
| Sync & migrate | `resolveSyncProvider`, `syncProviderResourcesFromContext`, `syncProviderResourcesFromEnv`, `migrateConfig` |
| Destroy | `planDestroyProjectContext`, `destroyPlannedProjectResources` |
| Agent | `buildAgentDecl`, `getAgent`, `listAgentsWithReadiness`, `listCloudAgents`, `archiveCloudAgent`, `syncAgentResourcesWithStateBackend`, `createCloudEnvironment`, `deleteCloudEnvironment`, `listCloudEnvironments`, `createCloudVault`, `deleteCloudVault`, `listCloudVaults` |
| Session | `createSessionForAgent`, `startSessionRun`, `startSessionRunPolling`, `sendSessionMessageStreaming`, `sendSessionMessagePolling`, `streamSessionEvents`, `getSession`, `listSessionSummaries`, `listSessionEvents`, `deleteSession`, `isTerminalSessionStatus`, `resolveSessionProvider` |
| Files & skills | `uploadFile`, `listFiles`, `getFileInfo`, `getFileDownloadUrl`, `deleteFile`, `createSkillFromFileId`, `listSkills`, `getSkillInfo`, `deleteSkill` |
| Deployment | `listDeploymentsForContext`, `getDeploymentDetailsForContext`, `getDeploymentRuntimeProviderForContext`, `runDeploymentForContext` |
| Models | `listProviderModelsForContext`, `listProviderNames` |
| State | `StateManager`, `LocalFileStateBackend`, `parseStateAddress` |
| Runtime context | `createProjectRuntime`, `readProjectRuntime`, `writeProjectRuntime` |
| Provider config | `resolveProviderConfigFromEnv`, `applyProviderConfigToEnv`, `loadDotEnv`, `bootstrapRuntimeCredentials` (and sync variants), `resolveActiveProvider`, `AGENTS_CONFIG_PROVIDERS`, `AGENTS_PROVIDER_FIELDS` |
| Sandboxing | `prependFileHint`, `preparePromptForProvider`, `rewriteFileMentions` |

## DTO and schema contract

Cross-boundary data shapes live in `internal/types/dto.ts` and are re-exported wholesale as the single source of truth — both the TypeScript types **and** their Zod schemas (e.g. `SessionSchema`, `PlannedActionSchema`, `AgentWithReadinessSchema`, `DiagnosticSchema`). Use the schemas to validate provider/HTTP payloads at the boundary.

Notable exported types: `ResolvedProjectConfig`, `ProjectSourceInspection`, `ResourceState`, `ExecutionPlan`, `PlannedAction`, `Diagnostic`, `Session`, `SessionEvent`, `CloudAgent`, `CloudEnvironment`, `CloudVault`, `ResourceType`, `ResourceAddress`, `ActionType`.

## Consumer rule

When adding a CLI or WebUI feature, ask:

1. Does an existing SDK service already perform the domain workflow?
2. If not, can a provider-neutral SDK service return the missing domain result?
3. If the desired result is presentation, transport, or product state, should it stay in the CLI/WebUI instead?

If a workflow seems to need parser outputs, provider adapters, or planner/executor internals, treat that as a missing SDK service rather than reaching into `src/internal/`.

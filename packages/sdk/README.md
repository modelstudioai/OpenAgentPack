# `@openagentpack/sdk`

The Node-compatible TypeScript SDK that powers [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack).

## Install

```sh
npm install @openagentpack/sdk
```

## Example

```ts
import { planProjectContext, resolveProjectConfig } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

## Local projects and versions

The same SDK package includes Node.js subpaths for directory projects and local
snapshots; no additional OpenAgentPack packages are required:

```ts
import { initializeDirectoryProject } from "@openagentpack/sdk/project-workspace";
import { createDirectoryProjectVersionService } from "@openagentpack/sdk/project-versions";
```

Use [project-workspace](https://github.com/modelstudioai/OpenAgentPack/blob/main/packages/sdk/docs/project-workspace.md)
for Init, Build, Publish, and validated directory restore. The lower-level
[project-versions](https://github.com/modelstudioai/OpenAgentPack/blob/main/packages/sdk/docs/project-versions.md)
subpath exposes snapshot storage primitives. Existing local snapshots remain
compatible without migration. These services are not re-exported from the SDK's
default entry point.

See the [configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md), [provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md), and [SDK documentation](https://github.com/modelstudioai/OpenAgentPack/tree/main/packages/sdk/docs).

## 百炼 Session 流恢复

旧调用默认仍使用 `legacy`，不启用快照、增量或自动重连；sanitizer 默认脱敏和截断保持开启。
显式使用 `snapshot` 的单轮发送在恢复时，以本次 POST 返回的事件 ID 限定历史回放，
避免上一轮的回复或结束状态提前结束本轮。缺少发送事件 ID 或历史中找不到该边界时，恢复会明确报错；
正常实时消费不要求发送响应带 ID，也不要求 SSE 回显用户消息。

取消订阅后停止交付实时缓冲和历史回放事件，并释放连接；取消观察不表示取消 Provider 执行。

## 浏览器中的百炼原始事件转换

自建后端透传原始 SSE 时，可从 `@openagentpack/sdk/session-events` 导入
`createBailianSessionEventNormalizer()`。`seed(raw)` 输入历史，`push(raw)` 输入已经解帧的
实时 JSON，均返回累计 `SessionEvent | undefined`；`clear()` 释放订阅状态。
每个订阅使用独立实例。默认脱敏、截断保持开启，完整正文显式传
`{ redact: false, truncate: false }`，不默认返回 raw。

进行中历史只供展示，不能成为新 delta 的追加基线；恢复需等待完整消息快照。
已输入历史的身份受 `maxEntries`（默认 1024）限制，溢出明确失败。
网络、凭据、就绪保证及重试仍由调用方后端和接入层负责。
详见 [SDK 参考](../../docs/reference/sdk.md#自建后端原始事件的浏览器转换)。

## 资源 Plan、执行结果与错误合同

目录项目与对象/YAML 入口共用资源执行器。服务端集成可在计划与执行时分别显式选择
`resultDetail: "structured"`：

```ts
const planned = await planProjectContext(context, { resultDetail: "structured" });
// 将 planned.fingerprint 与调用方的声明修订、上传内容一起绑定到显式确认。
const result = await executePlannedProject(planned, {
  resultDetail: "structured",
  policy: "force", // 仅在调用方已经核验用户确认后使用。
});
```

计划新增 `resource-plan-v1:` 前缀的语义指纹，不包含展示文案、时间戳、凭据或远端原始快照。
执行新增 `outcome`（succeeded/failed/partial/unknown）、`mutationStarted`，以及每项的
`resource.remoteId/version`、安全 `errorInfo`（code/phase/message/retryable/mutationStarted/httpStatus）。
抛出的 `ResourceRuntimeError` 携带安全 `info` 与已取得的 `execution`，原异常保留在 cause。
原有 `error` 字符串、异常 message/cause 可能含 Provider 原文，服务端不得直接传给浏览器或写入日志。

`mutationStarted=false` 才能证明本次执行未调用 Provider 写方法；调用后报错保守标记 unknown。
`retryable` 只描述临时性错误，不代表可以重发写请求。partial/unknown 不自动重试或回滚。
已取得的资源身份不是完整发布成功证明，调用方仍须负责状态、回执与恢复策略。
结构化报告保留 Provider 已返回的资源身份，包括 Vault 创建成功但后续凭据创建失败、
删除完成后 State 中已移除的身份。多步创建尚未完成时不把该资源写成已收敛的 State；
报告中的已知 ID 不代表可以自动重发、回滚或生成成功证明。

省略 `resultDetail`（或选择 `legacy`）保留原返回字段、partial 语义、异常类型与消息；
现有 CLI 无须接入新字段，不改变退出码、JSON 输出或确认策略。

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

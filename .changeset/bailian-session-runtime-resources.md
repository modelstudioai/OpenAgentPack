---
"@openagentpack/sdk": minor
---

为百炼 Managed Agents 增加会话运行时资源 API（挂载/列出/查详情/卸载），支持向已创建的
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

---
"@openagentpack/sdk": minor
---

新增百炼资源用量查询：`listModelUsage` / `listToolUsage` 对接 app-control `usage.listModelUsage` / `usage.listToolUsage`，支持 workspace/agent/session 三种 scope、毫秒级 time_range 交叉校验（session 禁止、其余必传）、来源与名称过滤及分页排序，并公开 `UsageScope`、`ModelUsagePage`、`ToolUsagePage` 等类型。apps/server 同步暴露 `POST /api/usage/models`、`POST /api/usage/tools` 并刷新 OpenAPI 快照。

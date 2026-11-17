---
"@openagentpack/sdk": minor
---

用量查询补齐百炼官方 Usage API 的 trend 端点，并收紧 summary 契约：

- 新增 `getUsageTrend(ctx, request, options)`（`POST /api/v1/agentstudio/usage/trend`）与 `UsageTrendRequest`、`UsageTrend`、`UsageTrendPoint`、`UsageTrendResponse`、`UsageTrendDimension`；支持 workspace/agent 维度、`hour/day/month` 分桶、`page_size`（1..100）与 `page_token` 游标分页，`has_more` / `next_page_token` 原样透传，缺数据的桶不补零
- 抽出 `UsageBreakdown`（`total/models/tools`），summary 与 trend 共用
- `UsageSummary.query_range` 改为可选：`session` 维度复用会话自身窗口，响应可能没有该字段
- 请求校验对齐文档：`time_range` 只接受秒级、带偏移的 RFC 3339（拒绝小数秒与无偏移时间）；`agent_id` / `session_id` / `agent_version` 不接受空白串；`granularity` 显式传 `null` 被拒绝；trend 的 `page_size` / `page_token` 非法值在发请求前拒绝

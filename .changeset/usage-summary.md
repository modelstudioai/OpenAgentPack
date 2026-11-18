---
"@openagentpack/sdk": minor
---

**BREAKING**：用量查询公开面合并为 `getUsageSummary`，按百炼官方 Usage API（`POST /api/v1/agentstudio/usage/summary`）的 `dimension` 契约一次返回 `total + models + tools`。

- 移除 `listModelUsage` / `listToolUsage` 及 `ModelUsagePage`、`ModelUsageRequest`、`ModelUsageItem`、`ToolUsagePage`、`ToolUsageRequest`、`ToolUsageItem`、`UsageScope`、`UsagePage`、`UsageTokenStats` 等类型
- 新增 `getUsageSummary(ctx, request, options)` 与 `UsageSummaryRequest`、`UsageSummaryResponse`、`UsageSummary`、`UsageMetric`、`UsageTotal`、`UsageModelRow`、`UsageToolRow`、`UsageDimension`、`UsageGranularity`
- 请求变化：`scope{type,...}` → `dimension` 判别联合；毫秒 `time_range` → 带时区偏移的 RFC 3339 字符串；分页与 `model_name`/`source`/`tool_name` 服务端筛选移除（明细随汇总一次返回）
- 响应变化：指标统一为 `{ value, unit }`，未知指标 `value: null`、已知零值 `0`；无统计记录时 `data_updated_at: null`

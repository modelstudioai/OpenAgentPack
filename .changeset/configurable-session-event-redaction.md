---
"@openagentpack/sdk": minor
---

为 `sanitizeSessionEvent()` 和 `sanitizeSessionEvents()` 增加独立的 `redact` 与 `truncate`
配置，保留默认开启脱敏和截断的行为。需要完整 SSE 内容的调用方可显式传入
`{ redact: false, truncate: false }`。导出 `SessionEventSanitizerOptions` 类型，
让 `metadata.tool_input` 使用同一脱敏策略，并保持 `includeRaw` 独立。

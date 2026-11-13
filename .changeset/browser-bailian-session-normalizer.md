---
"@openagentpack/sdk": minor
---

新增浏览器安全的 `createBailianSessionEventNormalizer`，从 `@openagentpack/sdk/session-events`
接收原始百炼业务帧并输出累计 `SessionEvent`。历史进行中消息保留展示及运行身份，等待完整快照
后恢复正文；完成消息保护、按实例隔离和有界缓存避免重连期间重复追加。既有 SDK 入口与
sanitizer 默认脱敏、截断行为不变。

同一浏览器子路径公开导出现有 `SessionEvent` 类型，纯浏览器调用方无需通过 SDK Node 主入口引用事件契约。

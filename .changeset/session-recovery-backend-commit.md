---
"@openagentpack/sdk": patch
"@openagentpack/playground": patch
---

修复百炼 Session 重连时历史结束状态抢先终止单轮读取的问题，确保恢复期间缓冲的完整回复先交付。
修复结构化资源执行在 StateBackend 最终提交失败时丢失报告的问题，保留远端写入状态、逐资源结果和已知资源 ID，legacy 异常行为保持兼容。

将 Playground 的 `@hono/node-server` 最低版本升级至 `2.1.6`，修复上游 WebSocket 连接重置和请求路径解析问题。

---
"@openagentpack/sdk": patch
---

修复会话文本处理中的两处正则回溯风险，使用线性扫描识别 Markdown 链接和 HTML 标签，保留媒体签名链接、敏感信息脱敏与截断边界的既有行为。

---
"@openagentpack/sdk": patch
---

修复百炼 BMA Session 混合流中 event_start/event_delta 的身份及正文累积，避免首个推理分片触发协议错误；保留完整消息、线程身份和断流恢复语义。

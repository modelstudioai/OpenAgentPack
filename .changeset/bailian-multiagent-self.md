---
"@openagentpack/sdk": minor
---

为百炼多智能体名册增加原生 `{type: "self"}` 成员，可独立使用或与项目 Agent、外部 Agent 混用。
补齐声明类型与严格校验、引用解析、发布映射、导出和漂移比较。Self 不生成普通自引用或额外受管资源，
计入名册上限并禁止重复及附带 ID/版本字段；其他 Provider 明确拒绝未验证的 Self 能力。

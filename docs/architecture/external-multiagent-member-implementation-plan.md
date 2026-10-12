# Multi-Agent 外部成员引用实施计划

## 背景与目标

OpenAgentBot 的一个 Bot 会对应一个独立的 Managed Agent。聊天室把多个既有 Bot 拉入同一个协作空间时，coordinator 必须能够引用并非由当前 OpenAgentPack 项目创建的 Managed Agent。

本阶段在现有同项目逻辑名引用之外，增加显式的远端 Agent 引用：

```yaml
multiagent:
  type: coordinator
  agents:
    - researcher
    - agent_id: agent_external_writer
```

配置 Interface 为：

```ts
type MultiagentMemberDecl = string | { agent_id: string };
```

- `string` 表示当前项目拥有的 Agent，参与依赖排序和生命周期管理；
- `{ agent_id }` 表示外部 Managed Agent，只作为 coordinator roster 的引用存在；
- 两种声明最终都在 resolver seam 后变成 Provider mapper 所需的远端 ID。

## 生命周期与所有权

外部成员不是当前项目的资源：

- 不要求存在于 `agents.state.json`；
- 不进入创建、更新或销毁依赖图；
- `apply` 只会更新 coordinator 的 roster，不会修改外部 Agent；
- `destroy` 不会删除或归档外部 Agent；
- drift comparison 继续按解析后的远端 ID 比较。

`agents sync` 根据完整的 `/agents` 列表恢复声明：当前项目拥有且可唯一命名的成员恢复为逻辑名；其他项目拥有或无 OpenAgentPack metadata 的成员恢复为 `{ agent_id }`。远端列表中完全不存在的 ID 仍然 fail closed；当前项目拥有但已归档、缺少逻辑名或逻辑名冲突的成员也继续 fail closed。

## Provider 范围

| Provider / delivery | `{ agent_id }` |
| --- | --- |
| Qoder Managed | 支持 |
| Bailian Managed | 支持 |
| Qoder Forward | 拒绝；Forward roster 需要 `template_id`，本阶段不引入外部 Template 语法 |
| Claude / Ark | 公共声明可透传为 Managed Agent ID，不新增 Provider 特有语义 |

## 实施顺序

1. 扩展公共类型和 Zod schema，校验空 ID 与重复外部 ID；
2. 让引用校验、拓扑、依赖图、运行时 readiness 和 destroy 仅遍历逻辑名成员；
3. resolver 直接接受外部 Agent ID，并对 Qoder Forward fail closed；
4. reverse/export 将非本项目成员稳定恢复为 `{ agent_id }`；
5. 更新配置参考、使用指南和 changeset；
6. 运行 multiagent/provider 定向测试、SDK 类型检查和 changed-files lint。

## 验收条件

- Managed coordinator 可混合引用本项目逻辑名和外部 `agent_id`；
- 外部成员不需要 state，且不会形成资源生命周期依赖；
- Qoder Forward 对 `{ agent_id }` 给出稳定、可定位的诊断；
- sync/apply/sync 保持外部 ID，不把它误认成本项目逻辑名；
- 原有纯逻辑名 roster 行为与 Provider wire payload 不回归。

## 非目标

本阶段不支持 `self`、Advisor、显式成员版本、外部 Forward Template（`template_id`）、跨项目资源导入或外部 Agent 的存在性/权限预检。

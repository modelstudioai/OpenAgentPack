# State Drift 恢复策略：设计决策与 Trade-off 分析

本文档记录 OpenAgentPack 处理 state drift（本地状态与远端不一致）的设计决策，包括从"拒绝 + 显式 import"到"apply 内自动 adopt"再到"plan-time refresh"的演进过程，以及业界工具的处理方式对比。

## 目录

- [问题本质](#问题本质)
- [业界工具的处理方式](#业界工具的处理方式)
- [候选方案与淘汰过程](#候选方案与淘汰过程)
- [最终选择：apply 内自动 adopt](#最终选择apply-内自动-adopt)
- [Plan-time Refresh](#plan-time-refresh)
- [已知 Trade-off](#已知-trade-off)
- [后续演进方向](#后续演进方向)

## 问题本质

所有基于本地 state 的 IaC 工具都面临同一个根本问题：本地 state 是"我认为远端是什么样"，不等于远端实际状态。

触发漂移的场景：state 文件丢失/损坏、手动操作远端、apply 部分失败、多人/多配置共享同一远端。

当 planner 基于过时的 state 做出 create 决策，executor 盲目执行 POST，远端 API 返回 409 Conflict。

## 业界工具的处理方式

| 工具 | 状态模型 | 遇到已存在资源时 | 恢复手段 |
|------|---------|----------------|---------|
| Terraform | 本地文件 | 拒绝 create，报错 | `terraform import` 显式认领 + `terraform refresh` 同步 |
| Pulumi | 本地/托管 | 拒绝 create，报错 | `pulumi import` 显式认领 + `pulumi refresh` 同步 |
| CloudFormation | 服务端托管 | 不存在本地 state 丢失 | `resource import`（2019 年加入）+ drift detection |
| Kubernetes | 服务端（etcd） | apply 前先 GET，天然幂等 | 不需要，apply = "确保达到此状态" |
| Helm | 服务端（Secret） | label 判断归属 | `helm adopt`（社区插件） |
| Ansible | 无状态 | 每次查现状再收敛 | 不需要，天然幂等 |

关键发现：维护本地 state 的传统工具（Terraform、Pulumi）选择了"拒绝 + 显式 import"策略。但这个模式的 UX 一直被社区诟病——Terraform 1.5 加了 `import` block 来降低摩擦，说明业界也在反思这个设计。

## 候选方案与淘汰过程

### 方案 A：Adapter 层逐个打补丁

在每个 adapter 的 `createX` 方法中 catch 409，list 远端资源按 name 查找，fallback 到 `updateX`。

淘汰原因：
- 5 资源 × 2 provider = 10 处重复的 try/catch 逻辑
- `createAgent` 变成 "create-or-adopt"，语义漂移
- 静默覆盖——用户完全不知道发生了什么

### 方案 B：Executor 层静默 auto-update

将 A 的逻辑上移到 executor，通过 `findResource` 接口统一处理。无日志，无提示。

淘汰原因：
- 架构更干净，但"静默"是核心问题——用户无法区分"新建成功"和"认领了已有资源"

### 方案 C：Metadata 归属判断 + 条件 adopt

409 时查远端资源的 `agents.project` metadata，匹配则自动 adopt，不匹配则拒绝，无 metadata 则交互确认。

淘汰原因：
- 没有主流工具采用此模式，是自创方案，缺乏大规模验证
- metadata 匹配 ≠ 安全——同项目不同配置文件有相同 metadata
- "有时自动有时不自动"的行为不确定性，用户无法预测
- 实现复杂度高，收益仅是省去一条 import 命令

### 方案 D：拒绝 + 显式 import（Terraform 模式）

409 时报错并提示 `agents state import` 命令，用户手动认领。

曾经选择此方案，后因 UX 问题调整：
- 用户需要手动查远端 remote-id（离开 CLI，curl API 或进控制台）
- 查到 id 后手动拼 import 命令
- 多资源 409 时要逐个重复以上步骤
- 整体流程对非专家用户门槛过高

### 方案 E：apply 内自动 adopt + 明确日志（最终选择）

executor 在 create 遇到 409 时，自动通过 `findResource` 查找远端资源并 adopt，日志明确标识。用户已在 apply 开头确认过意图，不需要二次确认。

## 最终选择：apply 内自动 adopt

方案 E 本质上是方案 B 的改进版——同样在 executor 层统一处理，但解决了 B 的核心问题：

| 方案 B 的问题 | 方案 E 的解法 |
|-------------|-------------|
| 静默覆盖，用户不知道发生了什么 | `⟳ adopt agent.assistant (qoder) — already existed remotely` 日志明确标识 |
| 可能覆盖别人的资源 | 用户已在 apply 确认步骤中审阅过 plan，表达了"让这些资源按我的配置生效"的意图 |

### 为什么偏离了 Terraform 的做法

Terraform 的"拒绝 + import"模式有其合理性（显式优于隐式），但存在 UX 问题：

1. **查 remote-id 的成本太高** — 用户必须离开 CLI、调用 API 或进控制台查找，这一步劝退了大部分非专家用户
2. **认知负担** — 用户需要理解"state"、"import"、"remote-id"三个概念才能恢复，而他们的意图只是"让我的配置生效"
3. **Terraform 自己也在改** — Terraform 1.5 (2023) 引入 `import` block 降低摩擦，说明 Terraform 团队也认为原有 import UX 有问题

OpenAgentPack 的场景比 Terraform 更适合自动 adopt：
- OpenAgentPack 管理的是 API 资源（agent、environment），不是基础设施（VM、数据库），误覆盖的影响范围和恢复成本远低于 Terraform
- OpenAgentPack 的 apply 已有交互确认步骤，用户意图明确
- OpenAgentPack 的资源可以通过 name 唯一定位（不像 Terraform 需要 import address 映射）

### 实现结构

```
BaseApiClient ──── ApiError(statusCode, responseBody)
                        │
ProviderAdapter ── findResource(type, name) → RemoteResource | null
                        │
Executor ────────── recoverFromConflict()
                    │  409 → findResource → updateFn(id) → log.adopt
                    │
                    └─ 非 409 错误正常抛出，不拦截
```

- `ApiError`：结构化错误，替代字符串匹配
- `findResource`：adapter 按 name 查找远端资源，executor 调用
- `recoverFromConflict`：统一恢复逻辑，一处代码覆盖所有 provider × 所有资源类型
- `agents state import`：保留命令，供 CI/CD 和非交互场景使用

## 已知 Trade-off

| Trade-off | 接受的代价 | 为什么可以接受 |
|-----------|-----------|--------------|
| 不再严格遵循"显式 import"的业界惯例 | 偏离了 Terraform 模式 | OpenAgentPack 的资源类型风险低于基础设施；用户已在 apply 确认步骤中表达意图；UX 收益远大于理论风险 |
| adopt 时会用当前配置覆盖远端状态 | 远端原有配置被更新 | 这正是用户执行 apply 的意图——"让远端和我的配置一致" |
| findResource 额外 API 调用 | 409 时多一次 list 请求 | 仅在 409 发生时触发，正常 create 不受影响 |
| 多配置文件场景仍可能互踩 | 两个配置文件定义同名资源时互相覆盖 | 已通过 config-scoped-state（独立 state 文件）降低此风险 |
| refresh 增加 API 调用 | 每次 apply 多 N 次 findResource 请求 | 仅在 state 非空时触发；可通过 `--no-refresh` 跳过；资源数量通常在 10 个以内 |

## Plan-time Refresh

### 解决的问题

auto adopt 解决了"正向漂移"（远端存在但本地 state 丢失），但无法处理"反向漂移"——远端资源被删除后本地 state 仍记录其存在，planner 判断为 no-op，导致资源永远不会被重建。

### 业界对比

| 工具 | 远端资源被删后的行为 | 是否需要手动操作 |
|------|-------------------|---------------|
| **Terraform** | plan/apply 自动隐式 refresh，检测到删除后 plan 为 create | 不需要 |
| **Pulumi** | 需要先 `pulumi refresh`，然后 `pulumi up` 重建 | 需要一步 |
| **Kubernetes** | 每次 apply 先查远端，不存在就创建 | 不需要 |
| **CloudFormation** | drift detection 标记为 DELETED，手动触发更新 | 需要 |

Terraform 的隐式 refresh 是业界公认的最佳实践——每次 plan/apply 前自动查询远端，将 state 与实际状态对齐。

### 设计决策

**采用 Terraform 模式：plan/apply 默认 refresh。**

| 命令 | 行为 | 理由 |
|------|------|------|
| `agents apply` | 默认 refresh（`--refresh=false` 跳过） | apply 本身就需要网络，refresh 不增加额外约束 |
| `agents plan` | 默认 refresh（`--refresh=false` 跳过） | Terraform-like plan 应默认反映远端真实状态 |
| `agents apply --refresh-only` | 只刷新 state，不修改远端 | 用于承认/审计远端变化 |

### 实现结构

```
refreshState(state, providers, { targetProviders, config })
  │
  ├─ for each resource in state:
  │    provider.readComparableResource(type, id, name)  // full support
  │      └─ null → state.removeResource() + log.gone()
  │      └─ found → remote_hash + drift_status
  │    provider.findResource(type, name)                // existence-only fallback
  │      └─ null → state.removeResource() + log.gone()
  │      └─ found → drift_status = unchecked
  │      └─ error → log.warn()（graceful degradation）
  │
  └─ state.save()  // 仅在有变更时保存
```

关键设计选择：
- **优先按 id 读取内容，必要时按 name fallback**：既能识别内容 drift，也能在 remote_id 失效时恢复
- **Comparable snapshot**：Provider 将远端 payload 规整为 OpenAgentPack 管理的可比较字段，避免时间戳、状态等只读字段造成误报
- **Graceful degradation**：API 错误不阻塞 refresh，仅警告后跳过，让 plan 继续基于现有 state
- **Provider 过滤**：`--provider` 选项限制 refresh 范围，避免不相关 provider 的网络请求
- **空 state 跳过**：state 为空时直接跳过 refresh（没有资源需要验证）

### 用户体验

```
$ agents apply -f agents.yaml
◐  Refreshing state...
⊘ environment.my-env (qoder) — not found remotely, will recreate
⊘ agent.my-agent (qoder) — not found remotely, will recreate
◇  State refreshed.

2 to create, 0 to update, 0 to destroy
  + environment.my-env (qoder)
  + agent.my-agent (qoder)
```

### 与 auto adopt 的互补关系

两个机制覆盖了 state drift 的两个方向：

| 漂移方向 | 场景 | 处理层 | 机制 |
|---------|------|-------|------|
| 正向：远端存在，本地 state 无 | state 丢失 / 手动在远端创建 | Executor | auto adopt（409 → findResource → update） |
| 反向：本地 state 有，远端不存在 | 手动在远端删除 / API 过期 | Planner | plan-time refresh（findResource → removeResource → create） |
| 内容：本地 state 有，远端内容被改 | 控制台/API 手动修改 | Planner | drift-aware refresh（remote_hash → update） |

## 已知 Trade-off（总表）

| Trade-off | 接受的代价 | 为什么可以接受 |
|-----------|-----------|--------------|
| 不再严格遵循"显式 import"的业界惯例 | 偏离了 Terraform 模式 | OpenAgentPack 的资源类型风险低于基础设施；用户已在 apply 确认步骤中表达意图；UX 收益远大于理论风险 |
| adopt 时会用当前配置覆盖远端状态 | 远端原有配置被更新 | 这正是用户执行 apply 的意图——"让远端和我的配置一致" |
| findResource 额外 API 调用 | 409 时多一次 list 请求 | 仅在 409 发生时触发，正常 create 不受影响 |
| 多配置文件场景仍可能互踩 | 两个配置文件定义同名资源时互相覆盖 | 已通过 config-scoped-state（独立 state 文件）降低此风险 |
| refresh 增加 plan/apply 延迟 | 每次 plan/apply 多 N 次远端读取 | 仅在 state 非空时触发；可通过 `--refresh=false` 跳过；资源数量通常在 10 个以内 |
| plan 不再默认离线 | 默认需要网络 | Terraform-like plan 应可信；离线场景显式使用 `--refresh=false` |

## 后续演进方向

每一步都独立有价值，不互相依赖：

1. **已完成** — apply 内自动 adopt + `agents state import`（非交互场景）
2. **已完成** — plan-time refresh，apply 前自动同步 state 与远端
3. **已完成** — Bailian/Qoder Agent 与 Environment 内容 drift detection + live validation
4. **近期** — `agents state list --remote` 查看远端资源列表（调试和审计用）
5. **远期** — 并行 refresh（当资源数量较多时，并发查询远端提升速度）

# Session 设计决策与 Trade-off 分析

本文档记录 OpenAgentPack Session 管理功能的核心设计决策，与 Terraform 等基础设施工具的对比分析，以及每个决策背后的 trade-off。

## 目录

- [核心问题：Session 是什么？](#核心问题session-是什么)
- [决策 1：两路架构 — IaC Pipeline vs Runtime Command](#决策-1两路架构--iac-pipeline-vs-runtime-command)
- [决策 2：不持久化 Session 到 State File](#决策-2不持久化-session-到-state-file)
- [决策 3：Agent 声明作为 Session 绑定模板](#决策-3agent-声明作为-session-绑定模板)
- [决策 4：通用 Ref 解析器替代领域专用函数](#决策-4通用-ref-解析器替代领域专用函数)
- [决策 5：Session 方法内聚在 ProviderAdapter](#决策-5session-方法内聚在-provideradapter)
- [业界对比矩阵](#业界对比矩阵)
- [未来演进方向](#未来演进方向)

---

## 核心问题：Session 是什么？

在 AI Agent 平台中，Session 是一个运行时实例 —— 它绑定了一个 Agent 定义、一个执行环境、可选的凭证库和记忆存储，形成一个可以接收消息并产生响应的会话上下文。

这里的关键区分是：**Session 是「使用」而非「容量」**。

```
基础设施（容量）              运行时（使用）
┌──────────────────┐        ┌──────────────────┐
│  Environment     │        │                  │
│  Vault           │───────▶│    Session        │
│  Memory Store    │        │                  │
│  Agent (定义)     │        │                  │
└──────────────────┘        └──────────────────┘
   plan / apply                session create
   声明式、幂等                  命令式、多实例
   状态持久化                    平台托管
```

这个区分决定了后续所有设计选择。

---

## 决策 1：两路架构 — IaC Pipeline vs Runtime Command

### 选择

Session 命令绕过 Planner/Graph/Executor，走独立路径：`CLI → SessionManager → Adapter → API`。

### Terraform 的做法

Terraform 严格坚守「管容量，不管使用」的边界：

| 概念 | Terraform 管理 | Terraform 不管 |
|------|---------------|---------------|
| EC2 | 实例定义、安全组、AMI | SSH 连接、进程管理 |
| Lambda | 函数定义、权限、触发器 | 单次调用 |
| RDS | 实例配置、参数组 | SQL 查询、连接 |

Terraform 不提供 `terraform invoke`、`terraform connect`、`terraform query` 命令。运行时操作由专门的工具（AWS CLI、kubectl）处理。

### 其他工具的做法

| 工具 | 定义管理 | 实例操作 | 边界 |
|------|---------|---------|------|
| Terraform | `plan/apply/destroy` | ❌ 不提供 | 最严格 — 只管定义 |
| Kubernetes | `kubectl apply` (Deployment) | `kubectl exec`, `kubectl logs` | 同一工具，不同子命令 |
| Serverless Framework | `sls deploy` | `sls invoke` | 同一工具，不同子命令 |
| Pulumi | `pulumi up` | ❌ 不提供 | 同 Terraform |

### OpenAgentPack 的选择

OpenAgentPack 选择了 **Kubernetes / Serverless Framework 路线** —— 同一 CLI 工具，不同子命令。

```
agents apply           # IaC 路径：声明式，plan/apply/destroy
agents session create  # Runtime 路径：命令式，直接调 API
```

### Trade-off

| 维度 | 选择的方案（内置 runtime） | 放弃的方案（纯 IaC） |
|------|------------------------|-------------------|
| **用户体验** | ✅ 一个工具完成全流程 | ❌ 需要额外学 curl / SDK |
| **职责清晰度** | ⚠️ 工具承担两类职责 | ✅ 单一职责 |
| **维护成本** | ⚠️ 更多代码路径要维护 | ✅ 代码量小 |
| **认知负担** | ⚠️ 需区分哪些命令走 IaC 哪些走 runtime | ✅ 所有命令行为一致 |
| **可扩展性** | ✅ 未来可加 message send, streaming | ❌ 每个功能都要外部工具 |

**为什么选这条路：** AI Agent 的核心价值在运行时交互。如果用户声明了 Agent 却需要手动拼装 Session API 调用，声明式配置的价值打了折扣。OpenAgentPack 的定位是 Agent 全生命周期工具，不是纯 IaC 引擎。

**风险：** 如果 runtime 命令持续膨胀（message、streaming、file upload），OpenAgentPack 可能演变为一个全功能 SDK CLI，模糊了 IaC 工具的核心定位。应对策略是：只做「启动和管理 session」，不做「session 内的交互」。

---

## 决策 2：不持久化 Session 到 State File

### 选择

`session create` 的结果不写入 `agents.state.json`。查看已有 session 通过 `session list` 实时查询平台 API。

### Terraform 的做法

Terraform 的 state file 跟踪所有受管资源。如果把 Session 作为 Terraform resource 管理：

```hcl
# 假设 Terraform 管理 Session（我们没有选择这条路）
resource "agent_session" "research_session" {
  agent_id       = agent.researcher.id
  environment_id = agent_environment.dev.id
  vault_ids      = [agent_vault.credentials.id]
}
```

问题立刻出现：
1. **1:N 关系**：一个 Agent 可以有无数 Session，但 Terraform 的 resource 是 1:1 声明式的
2. **状态漂移**：Session 有 idle/processing/expired 等运行时状态，state file 中的快照瞬间过期
3. **生命周期不匹配**：Session 可能被平台自动回收，state file 认为它还在，下次 plan 产生误删/重建

Terraform 社区对此类问题的共识是：**不要用 Terraform 管理短生命周期的运行时对象**。

### Trade-off

| 维度 | 选择的方案（不持久化） | 放弃的方案（写入 state） |
|------|-------------------|---------------------|
| **一致性** | ✅ 永远反映平台真实状态 | ❌ state 与平台可能漂移 |
| **离线查看** | ❌ 必须联网查询 | ✅ 离线能看到上次同步的列表 |
| **审计追踪** | ❌ 无本地历史 | ⚠️ state 不是审计日志 |
| **误操作恢复** | ⚠️ 删了就没了 | ⚠️ state 里有记录但平台上已删除 |
| **实现复杂度** | ✅ 简单 | ❌ 需要同步/reconcile 逻辑 |

**关键论据：** Terraform 的 state file 解决的核心问题是「远程资源没有声明式描述，需要本地记录 desired state 和 remote ID 的映射」。但 Session 的 remote ID 由平台返回，且平台提供了 `GET /sessions` 列表查询。本地持久化只会引入一致性问题。

---

## 决策 3：Agent 声明作为 Session 绑定模板

### 选择

`session create researcher` 自动读取 Agent YAML 中的 `environment`、`vault`、`memory_stores` 作为 Session 的默认绑定，CLI flag 可以覆盖。

```yaml
agents:
  researcher:
    environment: dev          # ← Session 默认使用 dev
    vault: api-credentials    # ← Session 默认绑定此 vault
    memory_stores: [kb]       # ← Session 默认挂载此记忆
```

```bash
# 使用默认值
agents session create researcher

# 覆盖环境
agents session create researcher --environment staging
```

### Terraform 的做法

Terraform 没有这种「模板继承」概念。每个 resource 块显式声明所有依赖：

```hcl
resource "aws_instance" "web" {
  ami           = "ami-12345"       # 显式
  subnet_id     = aws_subnet.a.id   # 显式引用
  security_groups = [aws_sg.web.id] # 显式引用
}
```

Terraform 认为隐式继承是危险的 —— 「显式优于隐式」。

### Kubernetes 的做法

Kubernetes 走了相反的路。Pod 从 Deployment 继承模板，ServiceAccount 从 Namespace 默认绑定，PVC 从 StorageClass 继承配置。K8s 大量使用默认值和继承。

### OpenAgentPack 的选择

偏向 Kubernetes 路线，因为：

1. Agent 声明中的 `environment`/`vault`/`memory_stores` 已经在表达「这个 Agent 的运行上下文」
2. 大多数 Session 使用与 Agent 声明一致的绑定 —— 需要覆盖的是少数情况
3. 如果不继承，用户每次 `session create` 都要传 4-5 个 flag，体验很差

### Trade-off

| 维度 | 选择的方案（继承 + 覆盖） | 放弃的方案（全显式） |
|------|----------------------|-------------------|
| **便利性** | ✅ 零 flag 即可创建 session | ❌ 每次都要写完整绑定 |
| **可预测性** | ⚠️ 需要查 YAML 才知道默认值 | ✅ 所见即所得 |
| **灵活性** | ✅ CLI flag 覆盖任意绑定 | ✅ 同等灵活 |
| **错误排查** | ⚠️ 需要理解继承逻辑 | ✅ 直白 |
| **配置变更影响** | ⚠️ 改 YAML 影响新 session 的默认值 | ✅ 无影响 |

**风险：** 如果 Agent 声明修改了 environment 但未重新 apply，`session create` 用的是新 YAML 里的 environment 名，解析出的是旧 state 里的 remote_id。这可能导致不一致。缓解措施：`requireRef` 在找不到资源时明确提示 `Run agents apply first`。

---

## 决策 4：通用 Ref 解析器替代领域专用函数

### 选择

用两个原子操作替代单体函数：

```typescript
// 之前：领域专用
function resolveAgentRefs(agentName, config, provider, state): ResolvedAgentRefs

// 之后：通用原子
function resolveRef(state, address): string | undefined
function requireRef(state, address): string
```

### Terraform 的做法

Terraform 使用表达式语言（HCL）中的 `resource.type.name.attribute` 引用机制。资源间的引用是一等公民，由 Terraform Core 的图引擎统一解析。

```hcl
# Terraform 的引用是声明式的，在 plan 阶段自动解析
environment_id = agent_environment.dev.id
```

Terraform 没有命令式的 `resolveRef` 函数 —— 引用解析嵌入在图遍历中。

### OpenAgentPack 为什么不能走 Terraform 路线

OpenAgentPack 没有声明式的 Session 资源定义，Session 是命令式创建的。命令式路径需要程序化的引用解析，即 `resolveRef`。

### Trade-off

| 维度 | 选择的方案（通用原子） | 放弃的方案（领域专用函数） |
|------|-------------------|---------------------|
| **可扩展性** | ✅ 新资源类型无需改 resolver | ❌ 每个消费者加一个函数 |
| **可组合性** | ✅ 消费者自由组合所需的 ref | ❌ 必须一次解析所有 ref |
| **类型安全** | ⚠️ 返回 string，无类型区分 | ✅ 返回类型化的结构体 |
| **错误信息** | ⚠️ 通用错误消息 | ✅ 可包含领域上下文 |
| **代码量** | ✅ resolver.ts 极简 | ❌ 随消费者增长 |

**为什么选通用方案：** `resolveAgentRefs` 原本包含了 `environment_id`、`vault_ids`、`memory_store_ids` 的解析逻辑，但这些字段在 Agent Create API 中从未使用（死代码）。它们真正的消费者是 Session Create。与其为 Session 再写一个 `resolveSessionRefs`，不如提供积木块让各消费者按需组装。

---

## 决策 5：Session 方法内聚在 ProviderAdapter

### 选择

Session CRUD 直接加到现有的 `ProviderAdapter` 接口，而不是创建独立的 `RuntimeAdapter`。

### Terraform Provider 的做法

Terraform Provider 只关心 CRUD 资源操作。如果需要运行时操作（如 `terraform console`），它通过完全独立的代码路径实现，不走 Provider 插件。

### 我们的考量

```
方案 A（选择）：             方案 B（放弃）：
┌─────────────────┐        ┌──────────────────┐  ┌──────────────────┐
│ ProviderAdapter  │        │  InfraAdapter    │  │ RuntimeAdapter   │
├─────────────────┤        ├──────────────────┤  ├──────────────────┤
│ createEnv()      │        │ createEnv()      │  │ createSession()  │
│ createAgent()    │        │ createAgent()    │  │ listSessions()   │
│ createSession()  │        │ ...              │  │ ...              │
│ listSessions()   │        └──────────────────┘  └──────────────────┘
│ ...              │
└─────────────────┘         两个接口，两个工厂
                            共享同一个 HTTP client
一个接口，一个工厂
```

### Trade-off

| 维度 | 选择的方案（单接口） | 放弃的方案（拆分接口） |
|------|-------------------|---------------------|
| **简洁性** | ✅ 一个接口、一个工厂 | ❌ 两个接口、两个工厂 |
| **职责清晰** | ⚠️ 接口混合了两类操作 | ✅ 各管各的 |
| **代码复用** | ✅ 共享 HTTP client 和认证 | ⚠️ 需要提取共享层 |
| **未来拆分** | ✅ 如果膨胀，拆分很自然 | - |
| **接口膨胀** | ⚠️ 接口方法数随功能增长 | ✅ 各接口保持精简 |

**判断依据：** 目前 Session 只有 4 个方法。如果未来 runtime 操作扩展到 10+ 个方法（message send、file upload、event streaming），应该拆分。但现在拆分是过早抽象。

---

## 业界对比矩阵

| 维度 | Terraform | Kubernetes | Serverless FW | OpenAgentPack |
|------|-----------|-----------|---------------|-----------|
| **定义语言** | HCL | YAML | YAML | YAML |
| **状态管理** | State file | etcd (服务端) | CloudFormation | State file |
| **运行时命令** | ❌ | ✅ `exec/logs/port-forward` | ✅ `invoke/logs` | ✅ `session` |
| **实例持久化** | 所有资源持久化 | 服务端管理 | 不持久化函数调用 | 不持久化 session |
| **模板继承** | Module 输入 | Pod template | 函数级 | Agent 声明 |
| **引用解析** | HCL 表达式 | Label selector | CloudFormation Ref | `resolveRef/requireRef` |
| **Provider 模型** | 插件（进程隔离） | API Server 内置 | 云厂商 SDK | 适配器（同进程） |

### 关键洞察

1. **Terraform 是最纯粹的 IaC** —— 它拒绝一切运行时操作。这带来了极高的可预测性，但在 AI Agent 场景下迫使用户使用多个工具。

2. **Kubernetes 把定义和运行时统一在一个工具中** —— `kubectl apply` 和 `kubectl exec` 共存。这种模式被广泛接受，因为运维人员需要在同一个上下文中管理和调试。

3. **Serverless Framework 最接近 OpenAgentPack 的场景** —— 函数定义通过 `deploy` 管理，函数调用通过 `invoke` 执行。Session 之于 Agent，就像 Invocation 之于 Lambda Function。

4. **OpenAgentPack 做了一个渐进式选择** —— 在 Terraform 的纯净性和 Kubernetes 的全面性之间取了中间位置。承认 runtime 需求，但限制 runtime 范围（只管 session 生命周期，不管 session 内交互）。

---

## 未来演进方向

当前设计为以下演进预留了空间：

### 短期可能

| 方向 | 影响 | 难度 |
|------|------|------|
| Session 模板（YAML 中声明 session 预设） | 新增 `sessions` 顶层块，SessionManager 优先读模板 | 低 |
| `session send` 发送消息 | Adapter 加方法，新 CLI 子命令 | 低 |
| Session 标签/过滤 | 扩展 `SessionFilter`，CLI 加 `--tag` flag | 低 |

### 中期考虑

| 方向 | 影响 | 难度 |
|------|------|------|
| 拆分 RuntimeAdapter | 接口拆分，需要新的工厂/注册机制 | 中 |
| Session 事件流 | WebSocket/SSE 接入，需要新的连接管理 | 中 |
| 批量 Session 操作 | 新的并发控制逻辑 | 中 |

### 需要警惕的边界

**一旦跨过「session 内交互」的边界**（实时消息、文件上传、工具审批），OpenAgentPack 就不再是 IaC 工具，而是一个 Agent runtime SDK 的 CLI 前端。这是一个需要有意识做出的决定，而不是功能蔓延的结果。

Terraform 的成功很大程度上归功于它坚决拒绝了这种蔓延。OpenAgentPack 选择了更宽的边界，但这个边界需要持续守护。

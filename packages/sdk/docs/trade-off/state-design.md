# State 设计决策与 Trade-off 分析

本文档记录 OpenAgentPack 状态管理的核心设计决策：为什么保留 state file、为什么不做 metadata-based discovery、如何精简到最小负担。

## 目录

- [核心问题：State File 存在的意义](#核心问题state-file-存在的意义)
- [决策 1：保留 State File，放弃 Metadata-Based Discovery](#决策-1保留-state-file放弃-metadata-based-discovery)
- [决策 2：精简到 4 个 Load-Bearing 字段](#决策-2精简到-4-个-load-bearing-字段)
- [决策 3：Metadata 标记注入策略](#决策-3metadata-标记注入策略)
- [决策 4：向后兼容加载，无需迁移工具](#决策-4向后兼容加载无需迁移工具)
- [决策 5：不做 State Refresh / State Import](#决策-5不做-state-refresh--state-import)
- [业界对比](#业界对比)
- [API 能力矩阵](#api-能力矩阵)

---

## 核心问题：State File 存在的意义

State file 在 IaC 工具中解决一个核心问题：**声明式配置中的资源名到远程 ID 的映射**。

```
YAML 配置                State File              远程平台
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ agents:      │      │ address:     │      │ id: agent_x  │
│   researcher │─────▶│   researcher │─────▶│ name: ...    │
│              │      │ remote_id:   │      │ model: ...   │
│              │      │   agent_x    │      │              │
└──────────────┘      └──────────────┘      └──────────────┘
```

没有 state file 时，工具不知道 YAML 中的 `researcher` 对应远程的 `agent_x`，就无法执行 update 或 delete。

理论上有两种替代方案可以绕过 state file：
1. **命名约定**：远程资源的 name 与 YAML 中的 key 一致，用 name 查找 → 但 name 不保证唯一、不是所有 API 都支持 name 查询
2. **Metadata 标记**：在远程资源上写入 `OpenAgentPack.resource=researcher` 标记，用 list + filter 找回 → 要求所有资源类型都支持 metadata 写入

OpenAgentPack 的结论是：**两种替代方案都无法统一实施，state file 仍然必要，但应精简到最小负担。**

---

## 决策 1：保留 State File，放弃 Metadata-Based Discovery

### 调研过程

对 Claude 和 Qoder 两个平台的每个资源类型，逐一检查 **CREATE/UPDATE 请求参数**（不是 response 字段）是否支持 metadata 写入：

| 资源类型 | Claude Create | Claude Update | Qoder Create | Qoder Update |
|---------|---------------|---------------|--------------|--------------|
| Agent | ✅ metadata | ✅ metadata | ✅ metadata | ✅ metadata |
| Environment | ✅ metadata | ✅ metadata | ✅ metadata | ✅ metadata |
| Vault | ✅ metadata | ✅ metadata | ❌ 无 metadata 参数 | ❌ 无 update 端点 |
| Skill | ❌ form-data 无 metadata | ❌ form-data 无 metadata | ❌ form-data 无 metadata | ❌ 只接受 name/description |
| MemoryStore | N/A | N/A | ❌ 只接受 name/description | N/A |

**结论**：5 种资源类型中只有 2 种（Agent/Environment）在两个平台上完整支持 metadata 读写。Skill 两端都不支持，Qoder 的 Vault 和 MemoryStore 也不支持。Metadata-based discovery 的覆盖率不足以替代 state file。

### 易犯的错误

初始调研时容易犯的错误是：**看 response 字段而非 request 参数**。API 返回 `created_at` 和 `metadata` 不代表你可以在 create 请求中设置它们。必须检查每个端点的请求参数文档。

### Trade-off

| 维度 | 保留 State File | Metadata-Based Discovery |
|------|----------------|--------------------------|
| **覆盖率** | ✅ 所有资源类型 | ❌ 只覆盖 Agent/Environment |
| **平台依赖** | ✅ 无 — 本地文件 | ❌ 依赖平台 metadata 能力 |
| **离线操作** | ✅ plan 不需要网络 | ❌ 必须在线查询 |
| **多项目隔离** | ⚠️ 每个项目一个 state 文件 | ✅ metadata 天然隔离 |
| **状态漂移** | ❌ state 可能与远程不一致 | ✅ 实时反映远程状态 |
| **运维负担** | ⚠️ 需要管理 state 文件 | ✅ 无额外文件 |

**判断依据**：覆盖率是硬约束。即使未来平台扩展了 metadata 支持，也无法追溯已创建的资源。State file 是唯一能统一覆盖所有资源类型的方案。

---

## 决策 2：精简到 4 个 Load-Bearing 字段

### 问题

初版 state file 照搬了 Terraform 的设计，10 个字段中只有 3 个被代码读取：

```
State File 字段分析
──────────────────────────────────────────────────────
                        写入者        读取者
──────────────────────────────────────────────────────
StateFile 级别
  version = 1           initialize()   （无）
  serial                save() +1      （无）
  lineage               initialize()   （无）

ResourceState 级别
  address               executor       planner, resolver, session-manager
  remote_id             executor       planner, resolver, session-manager
  content_hash          executor       planner
  version               executor       session-manager
  created_at            executor       （无）
  updated_at            executor       （无）
  attributes            executor       （无）
──────────────────────────────────────────────────────
```

7 个字段是 Terraform 惯例的照搬：
- **serial**：Terraform 用于 state locking 和并发控制。OpenAgentPack 单用户本地运行，从不读取
- **lineage**：Terraform 用于检测 state 文件是否被替换。OpenAgentPack 从不读取
- **version**（StateFile 级）：硬编码为 1，从未变化，从不读取
- **created_at / updated_at**：写入后从未被任何消费者读取。需要时可通过 GET API 实时获取
- **attributes**：存了完整 API response body，是 state 膨胀的最大来源。从未读取

### 精简后的类型

```typescript
// 精简前
interface StateFile {
  version: number;        // 删除 — 硬编码 1，从不读取
  serial: number;         // 删除 — save() 递增但从不读取
  lineage: string;        // 删除 — UUID，从不读取
  resources: ResourceState[];
}

interface ResourceState {
  address: ResourceAddress;
  remote_id: string;
  version?: number;
  content_hash: string;
  created_at: string;     // 删除 — 从不读取
  updated_at: string;     // 删除 — 从不读取
  attributes: unknown;    // 删除 — 存了整个 API response，从不读取
}

// 精简后
interface StateFile {
  resources: ResourceState[];
}

interface ResourceState {
  address: ResourceAddress;
  remote_id: string;
  version?: number;
  content_hash: string;
}
```

### 考虑过但放弃的方案

**保留 version 字段用于未来格式迁移**：不采纳。当需要格式迁移时再加回来（YAGNI）。且可通过字段存在性检测格式版本（有 `serial` → 旧格式，无 `serial` → 精简格式），不需要显式版本号。

**只删 attributes，保留 timestamps**：不采纳。timestamps 同样无人读取，保留它们要求 `RemoteResource` 接口继续返回 timestamps，传导到所有 provider adapter。

### Trade-off

| 维度 | 精简到 4 字段 | 保留全部 10 字段 |
|------|-------------|----------------|
| **State 文件大小** | ✅ 减少 ~70%（attributes 占主要体积） | ❌ 随资源数线性膨胀 |
| **认知负担** | ✅ 用户一眼看懂每个字段的用途 | ❌ 7 个字段看起来重要但没人用 |
| **未来扩展性** | ⚠️ 需要加字段时要处理兼容性 | ✅ 字段已在，直接用 |
| **信息丰富度** | ❌ 本地无法看到 attributes | ✅ state show 能展示完整信息 |
| **维护成本** | ✅ RemoteResource 接口只需返回 3 个字段 | ❌ 所有 provider 都要构造完整对象 |

---

## 决策 3：Metadata 标记注入策略

### 选择

虽然 metadata 覆盖率不足以替代 state file，但对支持 metadata 的资源类型，仍然注入 `OpenAgentPack.*` 标记。这是一个预留动作，不用于 discovery，但提供了平台侧的可追溯性。

### 注入机制

在 mapper 层（而非 adapter 层）注入，因为 mapper 是构造 API request body 的单一责任点：

```
配置声明                Mapper                     API Request
┌──────────────┐     ┌──────────────────┐      ┌──────────────────┐
│ metadata:    │     │ injectMetadata() │      │ metadata:        │
│   team: ml   │────▶│ merge:           │─────▶│   OpenAgentPack.     │
│              │     │  injected + user │      │     project: foo │
│              │     │  (user wins)     │      │   OpenAgentPack.     │
│              │     │                  │      │     resource: a1 │
└──────────────┘     └──────────────────┘      │   team: ml       │
                                                └──────────────────┘
```

注入的 key：
- `OpenAgentPack.project`：从 config 文件所在目录名推导
- `OpenAgentPack.resource`：资源在 YAML 中的声明名

用户优先级保证：`{ ...injected, ...userMetadata }` — 用户在 YAML 中声明的同名 key 不会被覆盖。

### 注入范围

```
                  Claude          Qoder
Agent             ✅ 注入          ✅ 注入
Environment       ✅ 注入          ✅ 注入
Vault             ✅ 注入          ❌ 不注入（API 不支持）
Skill             ❌ 不注入        ❌ 不注入
MemoryStore       N/A             ❌ 不注入
```

### 为什么不做全量注入

不对不支持 metadata 的资源类型做 workaround（如塞进 description 字段）：
1. description 是用户可见的展示字段，注入机器标记会干扰用户体验
2. 解析 description 中的结构化数据是脆弱的
3. 收益不足以证明复杂度 — 已经有 state file 做 discovery

### Trade-off

| 维度 | 注入 metadata 标记 | 不注入 |
|------|------------------|--------|
| **平台侧可追溯** | ✅ 可在平台 UI 看到哪些资源由 OpenAgentPack 管理 | ❌ 无法区分 |
| **metadata 配额** | ⚠️ Claude 限制 16 对，占用 2 个（12.5%） | ✅ 无消耗 |
| **复杂度** | ⚠️ mapper 需要接收 projectName 参数 | ✅ 无额外逻辑 |
| **未来演进** | ✅ 如果平台扩展 metadata 支持，可渐进 | ❌ 需要从零开始 |

---

## 决策 4：向后兼容加载，无需迁移工具

### 选择

`StateManager.load()` 使用 pick 模式：从 JSON 中只提取已知的 4 个字段，忽略多余字段。不做格式版本检测，不需要迁移工具。

```typescript
// 加载时只 pick load-bearing 字段
const resources = raw.map((r) => ({
  address: r.address,
  remote_id: r.remote_id,
  version: r.version,
  content_hash: r.content_hash,
  // created_at、updated_at、attributes 被自然忽略
}));
```

旧格式文件加载后，下次 `save()` 会写出精简格式。这是单向的：精简后不可逆，但也无损 — 被删除的字段从未被任何代码读取。

### 考虑过但放弃的方案

**显式迁移命令** `state migrate`：不采纳。pick 模式已经自动处理，无需用户干预。增加一个命令只是增加认知负担。

**加载时保留原始格式，save 时才精简**：不采纳。在内存中保留无用字段没有意义，且增加类型定义复杂度。

### Trade-off

| 维度 | Pick 模式自动兼容 | 显式迁移命令 |
|------|-----------------|-------------|
| **用户体验** | ✅ 零操作，透明升级 | ❌ 用户需要知道并执行迁移 |
| **可逆性** | ❌ save 后不可逆 | ✅ 可以选择不迁移 |
| **格式检测** | ❌ 无法判断文件版本 | ✅ 显式版本号 |
| **复杂度** | ✅ 2 行代码 | ❌ 新命令 + 版本检测逻辑 |

---

## 决策 5：不做 State Refresh / State Import

### 问题

State refresh（从远程状态重建本地 state）和 state import（将已有远程资源导入 state）是 Terraform 的重要功能。OpenAgentPack 选择暂不实现。

### 原因

1. **content_hash 无法从远程重建**：hash 是本地 YAML 声明经 SHA256 计算的摘要。Mapper 对数据做了不可逆变换（字段重命名、结构重组、默认值填充），无法从远程 API response 反推出原始 YAML 的 hash。如果 refresh 时把 hash 设为空值，下次 plan 会对所有资源强制 update。

2. **list 端点的覆盖率未验证**：虽然两个平台大概率支持 list 端点，但 adapter 接口未暴露 list 方法（validate 中的 `GET /agents?limit=1` 是写死的健康检查，不是通用 list）。State refresh 需要为所有资源类型加 list 方法。

3. **优先级低于精简**：精简是减法，refresh/import 是加法。先做减法降低复杂度，再考虑加法。

### Trade-off

| 维度 | 不做 refresh/import | 做 refresh/import |
|------|-------------------|-------------------|
| **手动修复** | ❌ state 损坏时需要手动编辑 JSON | ✅ 可以从远程重建 |
| **导入已有资源** | ❌ 无法纳管已有远程资源 | ✅ 可以导入 |
| **复杂度** | ✅ 不增加代码 | ❌ 需要 list 方法 + hash 策略 |
| **正确性** | - | ⚠️ refresh 后 hash 语义模糊 |

---

## 业界对比

### State 管理策略对比

| 工具 | State 存储 | State 内容 | Metadata Discovery | Refresh |
|------|-----------|-----------|-------------------|---------|
| **Terraform** | 本地文件 / 远程 backend | 完整资源快照（attributes 全量） | ❌ | ✅ `terraform refresh` |
| **Pulumi** | Pulumi Cloud / 本地文件 | 完整资源快照 | ❌ | ✅ `pulumi refresh` |
| **Kubernetes** | etcd（服务端） | 完整对象 YAML | ✅ label selector | N/A（服务端即真相） |
| **Serverless FW** | CloudFormation（服务端） | 栈资源映射 | ❌ | N/A（服务端即真相） |
| **OpenAgentPack** | 本地文件 | 精简映射 + 可选 remote hash/snapshot | 部分支持 | ✅（plan/apply 默认 refresh） |

### 关键洞察

1. **Terraform/Pulumi 存了太多**：完整 attributes 快照用于 drift detection 和 plan 输出；OpenAgentPack 只存必要映射和支持资源的可比较 remote hash/snapshot。

2. **Kubernetes/Serverless FW 没有 state file**：它们的 state 在服务端，工具直接查询。OpenAgentPack 管理的平台不是自建服务，无法控制服务端存储。

3. **OpenAgentPack 取了最小集**：默认只存必须的映射关系；对支持 drift detection 的资源额外存可比较 hash/snapshot。这是 Terraform 和 Kubernetes 之间的一个有意为之的中间位置。

### content_hash 与 Terraform 的 attributes 对比

```
Terraform 的变更检测：
  远程状态（attributes in state）  vs  期望状态（HCL 声明）
  → 可以检测 drift（远程被手动修改）

OpenAgentPack 的变更检测：
  上次部署的 YAML hash（desired_hash/content_hash）  vs  当前 YAML hash
  远端 comparable hash（remote_hash）              vs  上次 comparable desired hash
  → 支持资源可检测本地变更和远端内容 drift
```

这个差异是有意的设计选择：OpenAgentPack 不保存完整 provider attributes，只保存 OpenAgentPack 管理字段的可比较快照。当前 百炼/Qoder 的 Agent 与 Environment 已支持内容 drift detection；其他资源按 Provider 能力降级为存在性检查或未检查。

---

## API 能力矩阵

以下矩阵记录了 2026 年 6 月时两个平台的 API 能力，是决策的事实基础。

### Metadata 支持（CREATE/UPDATE 请求参数）

| 资源类型 | Claude Create | Claude Update | Qoder Create | Qoder Update |
|---------|:---:|:---:|:---:|:---:|
| Agent | ✅ | ✅ | ✅ | ✅ |
| Environment | ✅ | ✅ | ✅ | ✅ |
| Vault | ✅ | ✅ | ❌ | ❌（无端点） |
| Skill | ❌ | ❌ | ❌ | ❌ |
| MemoryStore | N/A | N/A | ❌ | N/A |

### 数据来源

- Claude Agent/Environment: `docs/claude-doc/beta/` — API 参数文档
- Claude Vault: `docs/claude-doc/beta/vaults.md` — create/update 均支持 metadata
- Claude Skill: `docs/claude-doc/beta/skills.md` — form-data 上传，无 metadata 参数
- Qoder Agent: `docs/qoder-skill/qoder-doc/agents/update.md` — 支持 metadata
- Qoder Environment: `docs/qoder-skill/qoder-doc/environments/update.md` — 支持 metadata
- Qoder Vault: `docs/qoder-skill/qoder-doc/vaults/create.md` — 无 metadata 参数，无 update 端点
- Qoder Skill: `docs/qoder-skill/qoder-doc/skills/create.md` — form-data，无 metadata
- Qoder MemoryStore: `docs/qoder-skill/qoder-doc/memory-stores/create.md` — 只接受 name/description

# 工作原理

[English](./how-it-works.md) | **简体中文**

本文档介绍 OpenAgentPack 的内部机制，包括执行流程、状态管理、依赖解析和增量检测。

## 整体流程

```
                        agents.yaml
                             │
                     ┌───────▼───────┐
                     │    Parser     │  解析 YAML + 环境变量插值
                     └───────┬───────┘
                             │
                     ┌───────▼───────┐
                     │   Validator   │  Zod Schema 校验
                     └───────┬───────┘
                             │
            ┌────────────────▼────────────────┐
            │       Dependency Graph          │  构建资源依赖图
            │  Environment ← Agent → Skill    │
            └────────────────┬────────────────┘
                             │
                     ┌───────▼───────┐
                     │    Planner    │  对比配置与状态，生成变更计划
                     └───────┬───────┘            │
                             │           ┌────────▼────────┐
                             │           │ State File      │
                              │           │ (agents.           │
                              │           │  state.json)    │
                     ┌───────▼───────┐   └─────────────────┘
                     │   Executor    │  按拓扑序执行操作
                     └───────┬───────┘
                             │
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
           ┌──────────┐ ┌────────┐ ┌────────┐
           │  Claude  │ │ Qoder  │ │  ...   │
           │ Adapter  │ │Adapter │ │        │
           └──────────┘ └────────┘ └────────┘
```

## 状态管理

### State File

OpenAgentPack 使用 `agents.state.json` 文件跟踪已创建的远程资源，结构如下：

```json
{
  "version": 1,
  "serial": 3,
  "lineage": "a1b2c3d4-...",
  "resources": [
    {
      "address": {
        "type": "environment",
        "name": "dev",
        "provider": "claude"
      },
      "remote_id": "env_abc123",
      "content_hash": "sha256:...",
      "created_at": "2025-01-01T00:00:00Z",
      "updated_at": "2025-01-01T00:00:00Z",
      "attributes": { ... }
    }
  ]
}
```

关键字段：

| 字段 | 说明 |
|------|------|
| `version` | State 文件格式版本 |
| `serial` | 自增序号，每次 save 递增 |
| `lineage` | UUID，标识此状态文件的唯一生命线 |
| `resources` | 已管理的资源列表 |

### 资源地址

每个资源通过三元组唯一标识：

```
<provider>.<type>.<name>
```

例如：`claude.agent.assistant`、`qoder.environment.dev`

### State 命令

```bash
# 列出所有已管理的资源
bun run dev state list

# 查看某个资源的详细状态
bun run dev state show claude.agent.assistant

# 从状态中移除资源（不删除远程）
bun run dev state rm claude.agent.assistant
```

`state rm` 用于手动修复状态，比如远程资源已被手动删除但状态文件未更新的情况。

## 依赖解析

### 依赖图

OpenAgentPack 根据配置中的引用关系自动构建有向无环图（DAG）：

```
Environment ◄─── Agent ───► Skill
                   │
            ┌──────┼──────┐
            ▼      ▼      ▼
         Vault  Memory  Sub-Agent
                Store   (multiagent)
```

依赖规则：
- Agent 引用 `environment` → 依赖对应的 Environment
- Agent 引用 `skills` → 依赖对应的 Skill
- Agent 引用 `vault` → 依赖对应的 Vault
- Agent 引用 `memory_stores` → 依赖对应的 Memory Store
- Agent 的 `multiagent.agents` → 依赖被编排的子 Agent

### 拓扑排序

依赖图经过拓扑排序后生成执行序列，确保：
- 被依赖的资源先创建（Environment → Skill → Agent）
- 依赖资源先删除（Agent → Skill → Environment，反序）
- 检测循环依赖并报错

### 依赖失败传播

执行过程中，如果某个资源操作失败，所有依赖它的下游资源会被自动跳过（标记为 `skipped`），避免级联错误。

## 增量检测

### Content Hash

OpenAgentPack 通过内容哈希判断资源是否需要更新：

1. 将资源的声明（YAML 中的配置对象）序列化
2. 计算 SHA-256 哈希
3. 与 State File 中记录的哈希对比

如果哈希相同，标记为 `no-op`（无操作）；如果不同，标记为 `update`。

### Skill 的特殊处理

Skill 的哈希不仅包含声明本身，还包含 `source` 目录下所有文件的内容哈希：

```
hash(skill 声明 + 目录内所有文件内容) → content_hash
```

这意味着修改技能目录中的任何文件都会触发 Skill 更新。

### 变更计划

`plan` 命令生成的每个操作包含：

| 字段 | 说明 |
|------|------|
| `action` | `create` / `update` / `delete` / `no-op` |
| `address` | 资源地址三元组 |
| `reason` | 变更原因 |
| `dependencies` | 该资源依赖的其他资源 |

判定逻辑：

```
配置中存在 + State 中不存在  →  create
配置中存在 + 哈希不一致      →  update
配置中存在 + 哈希一致        →  no-op
State 中存在 + 配置中不存在  →  delete
```

## Provider 适配器

每个 Provider 实现统一的 `ProviderAdapter` 接口：

```
ProviderAdapter
├── validate()                  验证认证
├── createEnvironment()         创建环境
├── updateEnvironment()         更新环境
├── deleteEnvironment()         删除环境
├── createVault()               创建凭证库
├── deleteVault()               删除凭证库
├── createSkill()               创建技能
├── updateSkill()               更新技能
├── deleteSkill()               删除技能
├── createAgent()               创建 Agent
├── updateAgent()               更新 Agent
├── deleteAgent()               删除 Agent
├── createMemoryStore()         创建记忆存储
└── deleteMemoryStore()         删除记忆存储
```

不支持的操作由 capabilities 层在 plan 阶段过滤，不会进入 Executor。

## 环境变量插值

配置文件中的 `${VAR_NAME}` 语法在运行时被替换为对应的环境变量值：

- `validate` 阶段不解析环境变量（离线校验）
- `plan` 和 `apply` 阶段解析环境变量
- 引用未设置的环境变量会抛出错误

Bun 运行时自动加载项目根目录的 `.env` 文件，无需额外配置。

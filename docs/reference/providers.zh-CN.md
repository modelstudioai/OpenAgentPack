# Provider 参考

[English](./providers.md) | **简体中文**

OpenAgentPack 通过 Provider 适配器与不同的 AI Agent 平台交互。每个 Provider 实现统一的资源操作接口，但各平台的能力有所差异。

## 支持的 Provider

| Provider | 配置键 | 认证方式 |
|----------|--------|---------|
| 百炼 | `bailian` | `api_key` + `workspace_id` |
| Qoder | `qoder` | `api_key`（个人访问令牌）+ 可选 `gateway` |
| Claude | `claude` | `api_key`（Anthropic API Key） |
| 火山方舟 | `ark` | `api_key`（火山方舟 API Key） |

## 能力矩阵

不同 Provider 对资源类型的支持程度不同，分为三个等级：

| 等级 | 含义 |
|------|------|
| **native** | 原生支持，平台提供对应的 API |
| **emulated** | 模拟支持，通过其他原语间接实现 |
| **unsupported** | 不支持，使用时会报错并给出替代建议 |

### 资源支持对照表

| 资源类型 | 百炼 | Qoder | Claude | 火山方舟 | 备注 |
|---------|------|-------|--------|----------|------|
| Environment | native | native | native | native | 四者均通过 API 管理云端环境 |
| Vault | native | native | native | native | 凭证库管理 |
| Skill | native | native | native | native | Claude 使用 files[]；其余 Provider 上传 zip |
| Agent | native | native | native | native | 核心资源 |
| MCP Server | native | native | native | native | 通过 Agent 的 MCP 配置挂载 |
| Memory Store | unsupported | native | unsupported | native | Qoder、方舟已接入；Claude 上游已有 Memory Store，但 OpenAgentPack Adapter 尚未实现 |
| Multi-Agent | unsupported | unsupported | native | native | Claude 与 火山方舟 支持 coordinator |
| Deployment | emulated | native | native | emulated | Qoder 和 Claude 使用原生 Deployment；百炼和火山方舟在 `run` 时展开为 Session |
| Session | native | native | native | native | 四者均原生支持 |

### Adapter 实现能力对照表

上表回答“某类资源能否声明和 apply”；下表回答“**当前 OpenAgentPack Adapter** 具体实现了哪些可选工作流”。表格描述的是本仓库代码，而不是 Provider 宣传的全部平台能力。

| Adapter 工作流 | 百炼 | Qoder | Claude | 火山方舟 | 实现说明 |
|----------------|:----:|:-----:|:------:|:--------:|----------|
| 枚举 Agent、Environment、Vault | yes | yes | yes | yes | 用于 Web UI 的云端资源发现 |
| 导出资源到 YAML（`sync`） | yes | yes | yes | limited | 方舟无法枚举 Skill，因此会跳过 Skill 导出 |
| 完整 Drift 内容比较 | Environment、Agent | Environment、Agent | no | no | 其他已支持资源降级为存在性检查；模拟 Deployment 仅有本地状态 |
| 枚举已上传文件 | yes | yes | yes | yes | 四个 Adapter 也都实现上传、元数据查询和删除 |
| 获取产物下载 URL | no | yes | no | no | Qoder 可返回短期有效的文件内容 URL |
| 枚举 Skill | yes | yes | yes | no | 方舟可按 ID 查询，但当前无法枚举 |
| `sync` 时下载 Skill 源文件 | no | no | yes | no | 当前仅 Claude 会把远端 Skill 包还原到本地 |
| Web UI 非阻塞创建 Skill 并轮询 | yes | no | no | no | 百炼可从已上传 file ID 创建，再由 UI 轮询扫描状态 |
| 枚举 Provider 模型 | no | yes | yes | no | Provider 暴露模型目录时用于模型选择 |
| 流式读取并分页查询 Session Event | yes | yes | yes | yes | 四个 Adapter 均转换为统一事件结构 |
| 从发送游标恢复事件流 | no | yes | no | no | Qoder 返回事件游标；其余 Provider 采用先连接、后发送避免漏事件 |

`yes` 表示实现了对应的可选 `ProviderAdapter` 接口；`no` 表示 OpenAgentPack 当前会对该工作流软降级，并不等价于上游平台永远不支持；`limited` 表示已实现但存在备注中的限制。

#### Provider 特有实现与限制

- **百炼**：Skill 通过 Files API 上传并支持扫描状态轮询；Agent 更新会生成平台侧版本；官方 MCP Server 按名称引用。
- **Qoder**：配置中的小写工具名会转换为 PascalCase；Session 发送返回游标，可恢复事件消费；Deployment 为原生资源，支持手动或定时运行。
- **Claude**：Deployment 是原生资源，具有服务端生命周期；当前只有 Claude Adapter 会在 `sync` 时下载远端 Skill 包。
- **火山方舟**：经本项目验证的 Skill API 行为仅支持创建、按 ID 查询和挂载。更新会重新上传，无法枚举和原地更新，删除为 best-effort；Deployment 由 Session 模拟。

#### Claude 与火山方舟专项调研

最后核验日期：**2026-07-17**。以下内容刻意区分“上游产品能力”和“OpenAgentPack 已实现能力”。

| 领域 | Claude Managed Agents（官方） | Claude Adapter | 火山方舟（官方公开资料） | Ark Adapter |
|------|-------------------------------|----------------|--------------------------|-------------|
| API 状态与协议 | Claude 直连 API 中 Messages/Models 为 GA；Managed Agents、Files、Skills 为 beta，相关接口要求 `managed-agents-2026-04-01` | 向 `api.anthropic.com/v1` 发送该 Beta Header | 官方 Managed Agents API 位于 `/api/v3`，使用 Bearer API Key | 使用官方文档中的 Base URL 和数据结构 |
| 有状态 Session | 服务端保存历史和沙箱状态，支持事件发送/流式读取、中断与恢复 | 已实现创建、枚举、查询、删除、发送、SSE 和事件历史分页 | 官方提供 Session CRUD、Event 发送/查询/流式读取、Session Resource 和 Multi-Agent Thread 接口 | 已实现创建、枚举、查询、删除、发送、SSE 和事件历史分页；尚未暴露 Session 更新、Resource、Thread |
| Environment | 每个 Session 使用隔离云沙箱；环境配置可复用，支持包缓存和网络策略 | 已实现 CRUD 和枚举 | 官方提供创建、枚举、查询、更新、删除接口 | 已实现 CRUD/枚举及存在性 Drift 检查 |
| Skill | 支持 Anthropic 内置 Skill 与自定义 zip/多文件上传；每 Session 最多 20 个 | 已实现 CRUD、枚举、查询和下载；Adapter 使用 `files[]` 上传 | 官方文档当前仅列出创建和查询详情 | 已实现创建、查询和挂载；更新通过重建模拟；枚举、删除是上游缺失 |
| Multi-Agent | Coordinator 可调度持久、上下文隔离的线程；共享沙箱、文件和 Vault | 已实现 Coordinator 拓扑 | Agent Schema 含 `multiagent`；Session API 提供 Thread 列表、详情、事件查询和流式读取 | 已实现 Coordinator 拓扑；`ProviderAdapter` 尚未暴露 Thread 查询 |
| Deployment | 原生定时 Deployment，支持 cron、时区和运行历史 | 已实现原生生命周期和运行 | 官方 Managed Agents API 目录中没有 Deployment 资源 | 本地模拟，运行时展开为 Session |
| Memory Store | 官方 API 支持跨 Session 持久化、版本化记忆，可只读/读写挂载；每 Session 最多 8 个 | **能力缺口：尚未接入**，因此 OpenAgentPack 中仍为 `unsupported` | 官方提供记忆库 CRUD，以及记忆创建、批量创建、枚举、查询、更新、删除 | 已实现记忆库创建、删除和 Session 挂载；枚举、查询、更新及记忆内容操作尚未接入 |

主要依据：[Claude API 总览](https://platform.claude.com/docs/en/api/overview)、[Claude Managed Agents 总览](https://platform.claude.com/docs/en/managed-agents/overview)、[Session Event Stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)、[Skills](https://platform.claude.com/docs/en/managed-agents/skills)、[Multi-Agent](https://platform.claude.com/docs/en/managed-agents/multi-agent)、[Scheduled Deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)、[Memory Stores](https://platform.claude.com/docs/en/managed-agents/memory)，以及[火山方舟 Managed Agents API 参考](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2555910?lang=zh)。

方舟官方目录还揭示了维护者需要区分的两类差距：Session 更新/Resource/Thread、Vault 更新与 Credential 生命周期、完整 Memory Store 操作属于“上游已有但 Adapter 尚未暴露”；Skill 只有创建和查询则是上游当前生命周期本身较窄，并非单纯漏实现。

#### 后续维护规则

新增 Provider 或可选 Adapter 方法时：

1. 在 `capabilities.ts` 更新资源级支持，并补齐对应生命周期方法。
2. 逐项核对 `ProviderAdapter` 的可选方法（枚举、sync/export、drift、文件、Skill、模型和 Session Event 恢复），同步更新本表。
3. 在 Adapter 注释中记录 API 端点或实测行为，并区分“上游 API 限制”和“本项目尚未实现”。
4. 运行 `bun test scripts/provider-docs.test.ts`；测试会同时校验资源矩阵和 Adapter 可选方法行，防止文档随代码漂移。

#### Provider 文档索引

刷新能力矩阵或新增 Adapter 方法时，优先从这些官方入口重新核验。不要只依据本仓库已有实现反推平台能力。

| Provider | 主要来源 | 辅助来源 | 备注 |
|----------|----------|----------|------|
| 百炼 | [Managed Agents 快速开始](https://help.aliyun.com/zh/model-studio/managed-agents-quick-start) | [百炼文档首页](https://www.alibabacloud.com/help/zh/model-studio/)、[智能体应用指南](https://help.aliyun.com/zh/model-studio/single-agent-application) | 快速开始展示了本 Adapter 使用的 `/api/v1/agentstudio` 端点族。 |
| Qoder | [Cloud Agents API overview](https://docs.qoder.com/cloud-agents/api/conventions/overview) | [Cloud Agents overview](https://docs.qoder.com/cloud-agents/overview)、[Agent Skills](https://docs.qoder.com/cloud-agents/skills)、[Cloud Agents marketplace skill](https://qoder.com/marketplace/skill?id=official_FjWvobU0) | API 文档是 gateway、鉴权头、资源、分页和事件流的主要依据。 |
| Claude | [Claude API 总览](https://platform.claude.com/docs/en/api/overview) | [Managed Agents 总览](https://platform.claude.com/docs/en/managed-agents/overview)、[Session Event Stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)、[Skills](https://platform.claude.com/docs/en/managed-agents/skills)、[Multi-Agent](https://platform.claude.com/docs/en/managed-agents/multi-agent)、[Scheduled Deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)、[Memory Stores](https://platform.claude.com/docs/en/managed-agents/memory) | API 总览用于确认 GA/beta 状态；Managed Agents 页面用于确认资源行为。 |
| 火山方舟 | [Managed Agents API 参考](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2555910?lang=zh) | [火山方舟文档中心](https://docs.volcengine.com/docs/82379)、[API Key 管理](https://www.volcengine.com/docs/6257/64983?lang=en) | Console API 参考是 `/api/v3` 资源目录依据，也确认 Deployment 不是一级资源。 |

### Drift Detection 支持

`plan` / `apply` 默认刷新远端状态。支持完整 drift detection 的资源会读取远端可比较内容并与上次 apply 的期望状态比较；检测到 drift 时，普通 `apply` 会把远端收敛回 YAML。其他资源会降级为存在性检查或标记为未检查。

| 资源类型 | 百炼 | Qoder | Claude | 火山方舟 | 说明 |
|---------|------|-------|--------|----------|------|
| Environment | full | full | 待验证 | existence | 火山方舟 当前执行存在性检查 |
| Agent | full | full | 待验证 | existence | 火山方舟 当前执行存在性检查 |
| Skill | existence | existence | existence | existence | 可发现缺失/删除，不比较包内容 |
| Vault | existence | existence | existence | existence | 凭证内容通常不可读回，不比较内容 |
| Memory Store | unsupported | existence | unsupported | existence | 可发现资源缺失 |
| Deployment | unsupported | native | native 路径待验证 | unsupported | 百炼和火山方舟的 emulated Deployment 为本地记录 |

Claude 的 drift detection 接口路径已预留；本仓库中的 live baseline 因 Anthropic API 账号余额不足未完成 Agent 创建验证。

### 不支持的资源处理

当配置中包含某 Provider 不支持的资源时：

- `validate` 阶段会输出警告诊断信息
- `plan` 阶段会跳过该资源，不生成操作
- 诊断信息中包含替代方案建议（`remediation`）

示例诊断输出：

```
claude.memory_store.unsupported:
  Claude exposes Memory Stores, but the OpenAgentPack adapter has not implemented them yet.
  use skill knowledge or MCP until Claude Memory Store support is added to the adapter

qoder.multiagent.unsupported:
  no multiagent primitive on Qoder.
  deploy agents independently and orchestrate via MCP
```

### 模拟（emulated）资源的能力降级

`emulated` 等级表示 Provider 没有对应的原生原语，OpenAgentPack 通过其他原语间接实现。Deployment 在百炼和火山方舟上为模拟实现：`apply` 时**不调用**部署 API（状态记录的 `remote_id` 为 `null`），而是在 `agents deployment run` 时展开为一个 Session 并回放 `initial_events`。

部分子特性在 emulated Provider 上无法在服务端执行。`plan`/`apply` 阶段会输出**警告**（不阻断部署），`run` 时尽力降级：

| 子特性 | Emulated Provider 行为 | 替代建议 |
|--------|-----------|---------|
| `schedule` | 不在服务端调度 | 用外部 cron/CI 定时触发 `agents deployment run` |
| `initial_events` 中的 `user.define_outcome` | 不做结果评分（rubric grading） | 将要求写入 `user.message` / `system.message` |
| `resources` 中的 `github_repository` | 不自动检出仓库 | 在 Session 内克隆仓库 |
| `resources` 中 `memory_store` 的 `access` / `instructions` | 忽略，按默认访问挂载 | — |

示例诊断输出：

```
⚠ bailian.deployment.schedule_unsupported
  Resource: deployment.daily-report (bailian)
  Schedules are not enforced server-side on this provider; trigger runs via external cron/CI.

⚠ bailian.deployment.define_outcome_unsupported
  Resource: deployment.daily-report (bailian)
  Outcome rubrics (user.define_outcome) are not enforced server-side on this provider; the run executes without rubric grading.
```

## Provider 配置

### 百炼（阿里云百炼 AgentStudio）

```yaml
providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}
```

`base_url` 通常无需声明，Adapter 会从 `workspace_id` 推导生产环境地址。

### Qoder

```yaml
providers:
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key` | string | 是 | Qoder 个人访问令牌 |
| `gateway` | string | 否 | API 网关地址，默认使用 Qoder 官方网关 |

**模型选择**：

运行以下命令查看当前账号可用的模型及其能力：

```bash
agents models list --provider qoder
```

输出示例：

```
Available models (qoder):

  ID               Display Name   Price   Efforts                        Default
  ──────────────── ────────────── ─────── ────────────────────────────── ───────
  auto             Auto           ×1      —                              —
  ultimate         Ultimate       ×1.6    low, medium, high              medium
  performance      Performance    ×1.2    low, medium, high              medium
  efficient        Efficient      ×0.8    low, medium                    low
  lite             Lite           ×0.4    —                              —
```

在 `agents.yaml` 中使用模型 ID：

```yaml
agents:
  assistant:
    model: auto               # 推荐：平台根据任务复杂度自动路由
  deep-thinker:
    model:
      id: ultimate
      effort: high            # 可选：指定推理力度
```

> 模型列表由 Qoder 平台动态提供，可能随时间变化。始终以 `agents models list` 的实时输出为准。

### Claude

```yaml
providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key` | string | 是 | Anthropic API Key，建议通过环境变量引用 |

**模型标识示例**：`claude-sonnet-4-6`、`claude-opus-4-6`

### 火山方舟（火山引擎方舟 Managed Agents）

```yaml
providers:
  ark:
    api_key: ${ARK_API_KEY}
```

## 多 Provider 配置

同时配置多个 Provider 时，通过 `defaults.provider` 控制默认部署目标：

```yaml
providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"

defaults:
  provider: all    # 部署到所有 Provider
  # provider: claude  # 只部署到 Claude
  # provider: qoder   # 只部署到 Qoder
```

单个资源可以通过 `provider` 字段覆盖默认值：

```yaml
agents:
  claude-agent:
    provider: claude
    model: claude-sonnet-4-6
    # ...

  qoder-agent:
    provider: qoder
    model: ultimate
    # ...
```

跨 Provider 部署时，`model` 字段使用 Record 格式为每个 Provider 指定模型：

```yaml
agents:
  universal-agent:
    model:
      claude: claude-sonnet-4-6
      qoder: ultimate
    # ...
```

## 工具名称差异

Claude 和 Qoder 的内置工具命名风格不同：

| 能力 | Claude | Qoder |
|------|--------|-------|
| 读取文件 | `read` | `Read` |
| 文件搜索 | `glob` | `Glob` |
| 文本搜索 | `grep` | `Grep` |
| 网页搜索 | `web_search` | `WebSearch` |
| 网页获取 | `web_fetch` | `WebFetch` |

OpenAgentPack 的 Adapter 层会自动处理这些差异，在配置中请使用目标 Provider 的原生命名。

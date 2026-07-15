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
| Memory Store | unsupported | native | unsupported | native | Qoder 与 火山方舟 原生支持 |
| Multi-Agent | unsupported | unsupported | native | native | Claude 与 火山方舟 支持 coordinator |
| Deployment | emulated | emulated | native | emulated | 非 Claude Provider 在 `run` 时展开为 Session |
| Session | native | native | native | native | 四者均原生支持 |

### Drift Detection 支持

`plan` / `apply` 默认刷新远端状态。支持完整 drift detection 的资源会读取远端可比较内容并与上次 apply 的期望状态比较；检测到 drift 时，普通 `apply` 会把远端收敛回 YAML。其他资源会降级为存在性检查或标记为未检查。

| 资源类型 | 百炼 | Qoder | Claude | 火山方舟 | 说明 |
|---------|------|-------|--------|----------|------|
| Environment | full | full | 待验证 | existence | 火山方舟 当前执行存在性检查 |
| Agent | full | full | 待验证 | existence | 火山方舟 当前执行存在性检查 |
| Skill | existence | existence | existence | existence | 可发现缺失/删除，不比较包内容 |
| Vault | existence | existence | existence | existence | 凭证内容通常不可读回，不比较内容 |
| Memory Store | unsupported | existence | unsupported | existence | 可发现资源缺失 |
| Deployment | unsupported | unsupported | native 路径待验证 | unsupported | emulated Deployment 为本地记录 |

Claude 的 drift detection 接口路径已预留；本仓库中的 live baseline 因 Anthropic API 账号余额不足未完成 Agent 创建验证。

### 不支持的资源处理

当配置中包含某 Provider 不支持的资源时：

- `validate` 阶段会输出警告诊断信息
- `plan` 阶段会跳过该资源，不生成操作
- 诊断信息中包含替代方案建议（`remediation`）

示例诊断输出：

```
claude.memory_store.unsupported:
  no memory store primitive on Claude.
  use skill knowledge or MCP for context persistence

qoder.multiagent.unsupported:
  no multiagent primitive on Qoder.
  deploy agents independently and orchestrate via MCP
```

### 模拟（emulated）资源的能力降级

`emulated` 等级表示 Provider 没有对应的原生原语，OpenAgentPack 通过其他原语间接实现。Deployment 在 百炼、Qoder、火山方舟 上为模拟实现：`apply` 时**不调用**部署 API（状态记录的 `remote_id` 为 `null`），而是在 `agents deployment run` 时展开为一个 Session 并回放 `initial_events`。

部分子特性在 emulated Provider 上无法在服务端执行。`plan`/`apply` 阶段会输出**警告**（不阻断部署），`run` 时尽力降级：

| 子特性 | Emulated Provider 行为 | 替代建议 |
|--------|-----------|---------|
| `schedule` | 不在服务端调度 | 用外部 cron/CI 定时触发 `agents deployment run` |
| `initial_events` 中的 `user.define_outcome` | 不做结果评分（rubric grading） | 将要求写入 `user.message` / `system.message` |
| `resources` 中的 `github_repository` | 不自动检出仓库 | 在 Session 内克隆仓库 |
| `resources` 中 `memory_store` 的 `access` / `instructions` | 忽略，按默认访问挂载 | — |

此外，`system.message` 事件在 Qoder 上会被展平为 `user.message`（Qoder 仅支持 `user.message` 作为出站事件），其内容仍会送达 Agent。

示例诊断输出：

```
⚠ qoder.deployment.schedule_unsupported
  Resource: deployment.daily-report (qoder)
  Schedules are not enforced server-side on this provider; trigger runs via external cron/CI.

⚠ qoder.deployment.define_outcome_unsupported
  Resource: deployment.daily-report (qoder)
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

## 数据来源

开发 Provider 适配器时，以下为各平台的官方 API 参考：

| Provider | 数据来源 | 说明 |
|----------|----------|------|
| Claude | https://platform.claude.com/llms.txt | Claude Platform API 规范 |
| Qoder | https://qoder.com/marketplace/skill?id=official_FjWvobU0 | Qoder Cloud Agents Skill 文档 |

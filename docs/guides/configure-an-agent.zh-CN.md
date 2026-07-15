# 配置指南

[English](./configure-an-agent.md) | **简体中文**

本文档按渐进式场景介绍 `agents.yaml` 的配置方式，从最简 Agent 到完整的多 Provider 部署。

## 目录

- [最简 Agent](#最简-agent)
- [配置运行环境](#配置运行环境)
- [挂载技能包](#挂载技能包)
- [接入 MCP 外部工具](#接入-mcp-外部工具)
- [凭证管理](#凭证管理)
- [记忆存储](#记忆存储)
- [多 Agent 协作](#多-agent-协作)
- [跨 Provider 部署](#跨-provider-部署)
- [Deployment 部署](#deployment-部署)
- [Session 管理](#session-管理)
- [完整字段参考](#完整字段参考)

---

## 最简 Agent

一个可以运行的最小配置只需要 Provider、Environment 和 Agent：

```yaml
version: "1"

providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}

defaults:
  provider: claude

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "通用编程助手"
    model: claude-sonnet-4-6
    instructions: |
      你是一个编程助手。
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

关键点：
- `version` 目前固定为 `"1"`
- `providers` 配置 API 认证信息，通过 `${VAR}` 引用环境变量
- `defaults.provider` 设置默认 Provider，资源未指定 `provider` 字段时使用此值
- `agents.*.instructions` 支持内联文本或文件引用（如 `./prompts/my-prompt.md`）

---

## 配置运行环境

Environment 定义 Agent 的云端运行沙箱，可以控制网络策略和预装软件包。

### 不限制网络

```yaml
environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted
```

### 限制网络

只允许访问特定主机，适合生产环境：

```yaml
environments:
  staging:
    description: "限制网络访问的预发环境"
    config:
      type: cloud
      networking:
        type: limited
        allow_mcp_servers: true
        allow_package_managers: true
        allowed_hosts:
          - "api.github.com"
          - "registry.npmjs.org"
      packages:
        apt: [git, curl]
        npm: [typescript]
    metadata:
      team: platform
```

### 网络配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"unrestricted"` \| `"limited"` | 网络策略类型 |
| `allow_mcp_servers` | boolean | 是否允许 MCP Server 连接 |
| `allow_package_managers` | boolean | 是否允许包管理器访问 |
| `allowed_hosts` | string[] | 白名单主机列表 |

### 预装包

支持多种包管理器：

```yaml
packages:
  apt: [git, curl, jq]
  pip: [requests, pandas]
  npm: [typescript, eslint]
  cargo: [ripgrep]
  gem: [bundler]
  go: [golang.org/x/tools/gopls@latest]
```

---

## 挂载技能包

Skill 是可复用的能力模块，从本地目录上传。

### 定义技能

```yaml
skills:
  code-review:
    source: ./skills/code-review/
    description: "结构化代码审查"
```

`source` 指向本地目录，目录内的所有文件会被打包上传。

### Agent 引用技能

```yaml
agents:
  reviewer:
    description: "代码审查专家"
    model: claude-sonnet-4-6
    instructions: ./prompts/reviewer.md
    environment: dev
    tools:
      builtin: [read, glob, grep]
      permissions:
        read: allow
        glob: allow
        grep: allow
    skills: [code-review]
```

`skills` 字段接收技能名称数组，引用在顶层 `skills` 中定义的技能。

也可以直接引用平台上已经存在的技能，这类引用只会绑定到 Agent，
不会被 OpenAgentPack 创建、更新或删除：

```yaml
agents:
  reviewer:
    model: qwen3.7-max
    instructions: ./prompts/reviewer.md
    skills:
      - code-review
      - type: official
        code: pptx
        version: "1.0"
      - type: custom
        skill_id: skill_uploaded_xxx
        version: "2.0"
```

`type: official` 用于平台官方 Skill，`type: custom` 用于已经上传到平台的自定义 Skill。
`skill_id` 是平台绑定 Agent 时使用的技能标识；官方 Skill 也可以用 `code` 简写，
例如百炼官方 PPTX Skill 可写 `code: pptx`。

### 工具权限

`tools.permissions` 可以为内置工具设置权限策略：

| 值 | 说明 |
|-----|------|
| `allow` | 自动允许，Agent 使用时无需人工确认 |
| `ask` | 每次使用前需要人工确认 |

## Drift Detection 与 Refresh

`plan` 和 `apply` 默认会先刷新远端状态。对于支持完整 drift detection 的资源，OpenAgentPack 会读取远端可比较内容；如果有人绕过 OpenAgentPack 在控制台或 API 中修改了资源，`plan` 会显示 `Remote drift detected`。

普通 `apply` 的方向始终是 **YAML -> remote**：继续执行会把远端资源收敛回当前 YAML。检测到远端 drift 或本地/远端同时变更时，CLI 会要求用户显式选择是否用 YAML 覆盖远端；取消不会把远端变更写回 YAML。若要保留远端变更，先取消，再用 `state show` 查看已刷新的远端快照并手动更新 YAML。

```bash
bun run dev plan                 # 默认刷新并检测 drift
bun run dev apply -y             # 默认刷新，并执行本地 YAML 收敛
bun run dev plan --refresh=false # 离线/快速模式，不检查远端 drift
bun run dev apply --refresh-only # 只记录刷新结果，不修改远端资源
bun run dev state show bailian.agent.assistant -f agents.yaml # 查看远端快照，辅助手动更新 YAML
```

当 Provider 或资源类型只支持存在性检查时，CLI 会提示该资源的内容 drift 未检查。当前 Qoder / 百炼 的 Agent 与 Environment 支持完整内容 drift detection；Skill、Vault、Memory Store 等资源按 Provider 能力降级为存在性或未检查。

---

## 接入 MCP 外部工具

通过 MCP（Model Context Protocol）协议接入第三方工具服务器。

```yaml
agents:
  github-assistant:
    description: "带 GitHub 访问能力的助手"
    model: claude-sonnet-4-6
    instructions: |
      你可以通过 MCP 访问 GitHub，浏览仓库、Issue 和 Pull Request。
    environment: dev
    tools:
      builtin: [read, glob, grep]
    mcp_servers:
      - name: github
        url: "https://mcp.example.com/github"
```

`mcp_servers` 是一个数组，每个元素包含：

| 字段 | 说明 |
|------|------|
| `name` | MCP Server 显示名称 |
| `type` | MCP Server 类型，可选：`url`（默认）、`http` 或 `official` |
| `url` | MCP Server 地址；`type: url` 时必填 |

MCP Server 通常需要配合 Vault 使用以提供认证凭证，见下一节。

对于百炼这类由平台托管的官方 MCP，可直接按官方名称引用，无需 Vault，也无需 `url`：

```yaml
agents:
  research-assistant:
    model: qwen3.7-max
    instructions: "Use official MCP tools when helpful."
    tools:
      builtin: [read, glob, grep]
      mcp:
        - type: mcp_toolkit
          mcpServerName: WebSearch
          defaultConfig:
            enabled: false
          configs:
            - name: bailian_web_search
              enabled: true
    mcp_servers:
      - type: official
        name: WebSearch
```

---

## 凭证管理

Vault 管理 MCP Server 的访问令牌，将敏感信息与 Agent 配置分离。

### 定义 Vault

```yaml
vaults:
  mcp-credentials:
    display_name: "MCP Server 凭证"
    credentials:
      - name: github-mcp
        mcp_server_url: "https://mcp.example.com/github"
        type: static_bearer
        access_token: ${MCP_GITHUB_TOKEN}
        protocol: streamable_http
```

### Agent 引用 Vault

```yaml
agents:
  github-assistant:
    # ...其他配置
    mcp_servers:
      - name: github
        url: "https://mcp.example.com/github"
    vault: mcp-credentials
```

### Credential 字段

| 字段 | 说明 |
|------|------|
| `name` | 凭证名称 |
| `mcp_server_url` | 对应的 MCP Server 地址 |
| `type` | 认证类型，目前支持 `"static_bearer"` |
| `access_token` | 令牌值，建议通过 `${ENV_VAR}` 引用 |
| `protocol` | 连接协议：`"sse"` 或 `"streamable_http"` |

---

## 记忆存储

Memory Store 为 Agent 提供持久化上下文，适合存储项目知识、约定规范等长期信息。

> 注意：Memory Store 目前由 Qoder 和 火山方舟 Provider 原生支持。

```yaml
memory_stores:
  project-kb:
    description: "项目知识库"
    entries:
      - key: architecture
        content: |
          系统采用微服务架构：
          - API Gateway (Go) 端口 8080
          - Auth Service (Rust) 端口 8081
          - Worker Service (Python) 消费 SQS 消息
      - key: conventions
        content: |
          代码规范：
          - Python 使用 snake_case，Go 使用 camelCase
          - 所有 API 返回 { data, error, meta } 信封格式
```

### Agent 引用 Memory Store

```yaml
agents:
  researcher:
    # ...其他配置
    memory_stores: [project-kb]
```

`memory_stores` 字段接收存储名称数组。

---

## 多 Agent 协作

通过 coordinator 模式，一个 Agent 可以调度其他 Agent 协同完成任务。

> 注意：Multi-Agent 目前由 Claude 和 火山方舟 Provider 原生支持。

```yaml
agents:
  researcher:
    description: "负责收集信息"
    model: claude-sonnet-4-6
    instructions: |
      你是调研员，负责从代码库和网络收集信息。
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]

  writer:
    description: "负责撰写文档"
    model: claude-sonnet-4-6
    instructions: |
      你是技术写手，根据调研结果撰写文档。
    environment: dev
    tools:
      builtin: [read, glob, grep]

  lead:
    description: "协调 researcher 和 writer"
    model: claude-sonnet-4-6
    instructions: |
      你是主管 Agent，协调团队：
      - researcher：搜索代码和网络
      - writer：撰写文档

      将任务拆分为调研和写作阶段，分别委派。
    environment: dev
    tools:
      builtin: [read, glob, grep]
    multiagent:
      type: coordinator
      agents: [researcher, writer]
```

`multiagent.agents` 中引用的 Agent 必须在同一配置文件中定义。OpenAgentPack 会自动处理依赖顺序，先创建子 Agent，再创建 coordinator。

---

## 跨 Provider 部署

同一份配置可以同时部署到多个 Provider。下面以 Claude 和 Qoder 为例：

```yaml
version: "1"

providers:
  claude:
    api_key: ${ANTHROPIC_API_KEY}
  qoder:
    api_key: ${QODER_PAT}
    gateway: "https://api.qoder.com/api/v1/cloud"

defaults:
  provider: all

agents:
  assistant:
    description: "同时部署到 Claude 和 Qoder"
    model:
      claude: claude-sonnet-4-6
      qoder: ultimate
    instructions: |
      你是一个编程助手。
    environment: dev
    tools:
      builtin: [read, glob, grep, web_search, web_fetch]
```

关键点：
- `defaults.provider: all` 表示所有资源同时部署到所有已配置的 Provider
- `model` 字段可以改为 Record 格式，为不同 Provider 指定不同模型
- 也可以在单个资源上通过 `provider` 字段指定只部署到某个 Provider

### 单独指定 Provider

```yaml
agents:
  claude-only-agent:
    provider: claude
    # ...

  qoder-only-agent:
    provider: qoder
    # ...
```

### 执行时指定 Provider

```bash
# 只 apply 到 Claude
bun run dev apply --provider claude

# 只 apply 到 Qoder
bun run dev apply --provider qoder

# 部署到所有 Provider（默认）
bun run dev apply --provider all
```

---

## Deployment 部署

Deployment 是介于「定义」与「运行」之间的声明式中间层。它把一个 Agent 连同其运行绑定（environment / vault / memory_stores）、初始事件（initial_events）和调度（schedule）打包成一个**可重复触发**的运行单元，并纳入 `plan/apply/destroy` 的状态管理。

三个平面的关系：

- **定义层**（Agent、Environment、Skill…）：声明可复用的能力，由 `apply` 创建。
- **部署层**（Deployment）：声明「用哪个 Agent、带哪些绑定、以什么初始事件和调度运行」。
- **运行层**（Session）：一次具体的执行实例。

> Provider 差异：Claude 原生支持 Deployment（对应平台的 deployments API，可服务端调度）；百炼、Qoder、火山方舟为**模拟**实现——`apply` 只写本地状态（`remote_id` 为 `null`），`agents deployment run` 时展开为一个 Session。详见 [Provider 参考](../reference/providers.zh-CN.md#模拟emulated资源的能力降级)。

### 定义 Deployment

```yaml
agents:
  reporter:
    model:
      claude: claude-sonnet-4-6
      qoder: ultimate
    instructions: ./prompts/reporter.md
    environment: dev
    memory_stores: [project-kb]

deployments:
  daily-report:
    agent: reporter
    description: "每日报告"
    schedule:
      expression: "0 9 * * *"     # 每天 09:00（Claude 服务端调度）
      timezone: UTC
    initial_events:
      - type: user.message
        content: "汇总昨天的提交并生成日报"
      - type: user.define_outcome
        description: "日报质量校验"
        rubric: "必须包含执行摘要与关键指标"
        max_iterations: 3
    resources:
      - type: memory_store
        memory_store: project-kb
        access: read_only
```

关键点：

- `agent` 必填，引用顶层 `agents` 中定义的 Agent。
- 未声明 `environment` / `vaults` / `memory_stores` 时，**继承所引用 Agent 的声明**；显式声明则覆盖。
- `schedule.expression` 为 cron 表达式；`timezone` 为必填的 IANA 时区标识。仅 Claude 在服务端执行调度，百炼、Qoder、火山方舟需用外部 cron/CI 触发。
- `initial_events` **必填**（1–50 条），在 Deployment 运行时按顺序投递给 Agent。

### 初始事件（initial_events）

| 事件类型 | 字段 | 说明 |
|---------|------|------|
| `user.message` | `content` | 以用户身份发送的消息 |
| `system.message` | `content` | 系统提示（Qoder 上展平为 `user.message`） |
| `user.define_outcome` | `description` / `rubric` / `rubric_file` / `max_iterations` | 定义结果评分目标（仅 Claude 服务端执行评分） |

### 资源（resources）

Deployment 运行时可挂载的资源：

| 资源类型 | 字段 | 说明 |
|---------|------|------|
| `file` | `file_id` / `source` / `mount_path` | 文件资源；`file_id` 引用已上传文件；`source` 为本地路径，Claude 在 `apply` 时上传、Qoder 在 `run` 时上传 |
| `memory_store` | `memory_store` / `access` / `instructions` | 引用 Memory Store；`access` 为 `read_write`（默认）或 `read_only` |
| `github_repository` | `url` / `checkout` / `mount_path` / `authorization_token` | 检出 Git 仓库（仅 Claude） |

### 运行与查看

```bash
# 列出状态中的 Deployment
bun run dev deployment list

# 查看单个 Deployment 状态与解析后的绑定
bun run dev deployment get daily-report

# 触发一次运行（Claude 调用平台 run；其他 Provider 展开为 Session）
bun run dev deployment run daily-report

# 多 Provider 时指定目标
bun run dev deployment run daily-report --provider qoder
```

Deployment 的创建/更新/删除通过 `plan/apply/destroy` 管理（`destroy` 时 Deployment 先于其依赖被销毁）：

```bash
bun run dev plan       # 查看将创建的 Deployment
bun run dev apply      # 创建/更新（Claude 调用 API，其他 Provider 写本地状态）
bun run dev destroy    # 删除
```

---

## Session 管理

Session 是 Agent 的运行时实例。与基础设施资源（Environment、Vault 等）不同，Session 不通过 `plan/apply` 管理，而是通过独立的运行时命令操作。

### 创建 Session

```bash
# 使用 Agent 声明中的默认配置创建 Session
bun run dev session create researcher

# 覆盖 Agent 声明中的绑定
bun run dev session create researcher \
  --environment staging \
  --vault other-credentials \
  --memory-stores "docs,logs" \
  --title "调研任务 #42"

# 多 Provider 场景，需要指定 Provider
bun run dev session create researcher --provider qoder
```

Session 继承 Agent 声明中的 `environment`、`vault`、`memory_stores` 配置作为默认值。CLI 参数可以覆盖任意绑定。所有引用的资源必须已在配置中定义并通过 `apply` 完成部署。

### 查看 Session

```bash
# 列出所有 Session
bun run dev session list

# 按 Agent 过滤
bun run dev session list --agent researcher

# 查看单个 Session 详情
bun run dev session get sess_abc123

# 删除 Session
bun run dev session delete sess_abc123
```

### Session 命令参数

| 命令 | 参数 | 说明 |
|------|------|------|
| `session create <agent>` | `--environment` | 覆盖 Agent 声明中的 Environment |
| | `--vault` | 覆盖 Agent 声明中的 Vault |
| | `--memory-stores` | 覆盖 Agent 声明中的 Memory Store（逗号分隔） |
| | `--title` | Session 标题 |
| | `--provider` | 目标 Provider（多 Provider 时必填） |
| `session list` | `--agent` | 按 Agent 名称过滤 |
| | `--provider` | 目标 Provider |
| `session get <id>` | `--provider` | 目标 Provider |
| `session delete <id>` | `--provider` | 目标 Provider |

### 设计理念

Session 的架构遵循 Serverless Framework 模式：**定义管理**（`plan/apply/destroy`）与**实例操作**（`session create/list/get/delete`）分离。

- 基础设施资源有状态文件跟踪、变更计划、幂等部署
- Session 作为运行时实例，由平台管理生命周期，不需要本地状态持久化
- Agent 声明中的资源绑定作为 Session 的默认模板，CLI 可按需覆盖

---

## 完整字段参考

### 顶层结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | string | 是 | 配置版本，目前为 `"1"` |
| `providers` | Record | 是 | Provider 配置 |
| `defaults` | object | 否 | 默认配置 |
| `environments` | Record | 否 | 运行环境定义 |
| `vaults` | Record | 否 | 凭证库定义 |
| `skills` | Record | 否 | 技能包定义 |
| `memory_stores` | Record | 否 | 记忆存储定义 |
| `agents` | Record | 否 | Agent 定义 |
| `deployments` | Record | 否 | Deployment 定义 |

### Provider 配置

**Claude**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key` | string | 是 | Anthropic API Key |

**Qoder**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key` | string | 是 | Qoder 个人访问令牌 |
| `gateway` | string | 否 | API 网关地址 |

### Agent 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 否 | Agent 描述 |
| `model` | string \| Record | 是 | 模型标识，多 Provider 时用 Record |
| `instructions` | string | 是 | 系统指令，支持内联文本或文件路径 |
| `environment` | string | 否 | 引用的 Environment 名称 |
| `provider` | string | 否 | 指定 Provider，覆盖 defaults |
| `tools` | object | 否 | 工具配置 |
| `tools.builtin` | string[] | 否 | 内置工具列表 |
| `tools.permissions` | Record | 否 | 工具权限策略 |
| `mcp_servers` | array | 否 | MCP Server 列表 |
| `skills` | string[] | 否 | 引用的技能名称 |
| `vault` | string | 否 | 引用的 Vault 名称 |
| `memory_stores` | string[] | 否 | 引用的 Memory Store 名称 |
| `multiagent` | object | 否 | 多 Agent 协作配置 |
| `metadata` | Record | 否 | 自定义元数据 |

### Deployment 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | string | 是 | 引用的 Agent 名称 |
| `agent_version` | number | 否 | 固定 Agent 版本 |
| `environment` | string | 否 | 覆盖 Agent 的 Environment |
| `vaults` | string[] | 否 | 覆盖 Agent 的 Vault（数组） |
| `memory_stores` | string[] | 否 | 覆盖 Agent 的 Memory Store |
| `resources` | array | 否 | 运行时挂载的资源（file / memory_store / github_repository） |
| `initial_events` | array | 是 | 运行时投递的初始事件（user.message / system.message / user.define_outcome），1–50 条 |
| `schedule` | object | 否 | cron 调度（`expression` + 必填 `timezone`），仅 Claude 服务端执行 |
| `description` | string | 否 | 描述 |
| `provider` | string | 否 | 指定 Provider，覆盖 defaults |
| `metadata` | Record | 否 | 自定义元数据 |

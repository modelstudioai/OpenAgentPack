# OpenAgentPack 开源文档体系规划

本文档用于规划 OpenAgentPack 开源前后的文档信息架构。目标不是简单补齐文件，而是把现有文档整理成外部开发者可以自助理解、试用、集成、贡献的开源产品文档体系。

## 一、规划目标

OpenAgentPack 当前已经具备开源项目的基础文档和治理文件，包括 README、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、MAINTAINERS、LICENSE、docs、examples 与 package README。

下一步的核心目标是：

1. 让第一次进入仓库的人在 30 秒内理解项目价值。
2. 让新用户在 5 分钟内跑通第一个 `agents.yaml`。
3. 让真实用户能按任务找到配置、Provider、Session、Deployment、MCP、Vault、Skill 等指南。
4. 让贡献者能理解开发环境、包边界、Provider 扩展方式与合并要求。
5. 让维护者材料、发布材料、内部设计材料不干扰公开用户文档主线。

参考的顶尖开源文档模式：

- Kubernetes：Understand / Try / Set up / Tasks / Reference / Contribute。
- Next.js：Getting Started / Guides / API Reference。
- Terraform：Language / Providers / CLI workflow / Registry-style reference。

OpenAgentPack 更接近 Terraform + Kubernetes 的组合：它既有声明式配置语言，也有 Provider 差异、资源生命周期、状态管理和运行时会话。

## 二、当前文档现状

### 1. 项目门面层

当前入口：

- `README.md`
- `README.zh-CN.md`

现有结构：

```text
定位与价值主张
为什么需要 OpenAgentPack
仓库结构
安装
Quick Start
核心概念
Provider 支持
CLI reference
SDK
WebUI
Examples
Documentation
Contributing / Security / License
```

判断：

- 优点：开源首页要素基本齐全，能解释项目价值和基本用法。
- 问题：README 承担了过多细节，既是首页又是教程又是参考文档。开源后应压缩为入口页，把细节导向 docs。

### 2. 公共用户文档层

当前入口：

- `docs/README.md`
- `docs/configuration.md`
- `docs/providers.md`
- `docs/how-it-works.md`
- 对应中文翻译 `.zh-CN.md`

现有约定：

- 英文文档是 canonical source。
- 中文文档使用 `.zh-CN.md` 后缀。
- `launch-*` 是发布传播材料，不是产品参考文档。

判断：

- 优点：已经有清楚的用户文档主线。
- 问题：当前主线偏少，且 guide、concept、reference 混在一起。比如 `configuration.md` 既像教程，也像字段参考。

### 3. 示例层

当前入口：

- `examples/README.md`
- `examples/claude/*`
- `examples/qoder/*`
- `examples/bailian/*`
- `examples/ark/*`
- `examples/runtime/*`

判断：

- 优点：按 Provider 和功能场景组织，适合作为开源项目的 runnable examples。
- 问题：`examples/README.md` 当前中文为主，和“英文 canonical”的规则不一致。

### 4. 包级文档层

当前入口：

- `packages/cli/README.md`
- `packages/sdk/README.md`
- `packages/playground/README.md`
- `packages/sync-extension/README.md`
- `packages/sdk/docs/*`

判断：

- package README 适合作为 npm 页面说明，保持简短即可。
- `packages/sdk/docs/*` 中有较多内部设计、发布、trade-off 文档，更适合归入维护者或架构资料，不应进入新用户主路径。

### 5. 开源治理层

当前入口：

- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `MAINTAINERS.md`
- `LICENSE`
- `.github/ISSUE_TEMPLATE/*`
- `.github/pull_request_template.md`
- `.github/workflows/*`

判断：

- 基础开源治理文件齐全。
- 后续重点是把贡献路径写得更可执行，尤其是新增 Provider、运行测试、发布流程。

### 6. 发布和内部材料层

当前入口：

- `docs/launch-announcement.md`
- `docs/launch-announcement.zh-CN.md`
- `docs/launch-social.md`
- `docs/launch-positioning-brief.md`
- `docs/project-proposal.zh-CN.md`
- `docs/open-source-release-checklist.md`

判断：

- 这些材料有价值，但不是用户产品文档。
- 应该明确移动到 `docs/launch/`、`docs/internal/` 或 `docs/maintainers/`，避免外部用户误以为它们是产品文档主线。

## 三、目标信息架构

建议整理后的文档结构：

```text
README.md
README.zh-CN.md

docs/
  README.md
  getting-started.md
  getting-started.zh-CN.md

  concepts/
    agents-as-code.md
    resources.md
    state-and-drift.md
    sessions-and-deployments.md

  guides/
    configure-an-agent.md
    deploy-to-claude.md
    deploy-to-qoder.md
    deploy-to-bailian.md
    deploy-to-ark.md
    use-skills.md
    use-mcp-and-vaults.md
    multi-provider.md
    run-sessions.md
    manage-deployments.md

  reference/
    configuration.md
    cli.md
    providers.md
    sdk.md
    openapi.md

  examples.md

  architecture/
    how-it-works.md
    adr/

  contributing/
    development.md
    provider-development.md
    release.md

  maintainers/
    open-source-release-checklist.md

  launch/
    launch-announcement.md
    launch-announcement.zh-CN.md
    launch-social.md
    launch-positioning-brief.md

  internal/
    project-proposal.zh-CN.md
```

说明：

- `docs/README.md` 是文档首页，负责分流。
- `getting-started` 是最短成功路径。
- `concepts` 解释心智模型，不放长配置清单。
- `guides` 按任务组织，面向实际使用。
- `reference` 放字段、命令、Provider 能力矩阵和 API 事实。
- `architecture` 面向深度用户和贡献者。
- `contributing` 面向外部贡献者。
- `maintainers` 和 `internal` 不进入普通用户主路径。
- `launch` 保留传播材料，但和产品文档隔离。

## 四、读者路径设计

### 1. 第一次访问 GitHub 的用户

入口：

```text
README.md
```

需要回答：

- OpenAgentPack 是什么？
- 它解决什么痛点？
- 和 Terraform / 普通控制台点击相比有什么不同？
- 当前支持哪些 Provider？
- 如何最快跑起来？
- 文档入口在哪里？

README 应该保留：

- 一句话定位。
- 关键价值点。
- 最短 Quick Start。
- 一个最小 `agents.yaml`。
- 文档导航。
- 贡献、安全、许可证入口。

README 应该移出：

- 过长 CLI reference。
- 过完整 Provider matrix。
- 详细概念解释。
- WebUI 和 SDK 的长说明。

### 2. 想快速试用的用户

入口：

```text
docs/getting-started.md
```

需要回答：

- 需要什么环境？
- 如何安装 CLI？
- 如何配置 API key？
- 如何生成 `agents.yaml`？
- 如何运行 validate / plan / apply？
- 如何确认成功？
- 如何 destroy 清理资源？

建议结构：

```text
Prerequisites
Install
Create your first project
Configure credentials
Validate
Plan
Apply
Run a session
Clean up
Next steps
```

### 3. 想正式接入项目的用户

入口：

```text
docs/guides/*
docs/concepts/*
docs/reference/*
```

需要按任务找到答案：

- 配置一个 agent。
- 接入 百炼 / Qoder / Claude / 火山方舟。
- 使用 skills。
- 使用 MCP server 和 vault。
- 做多 Provider 部署。
- 管理 sessions。
- 管理 deployments。
- 处理 drift。

### 4. 想查字段或命令的用户

入口：

```text
docs/reference/configuration.md
docs/reference/cli.md
docs/reference/providers.md
docs/reference/sdk.md
docs/reference/openapi.md
```

要求：

- 参考文档必须稳定、准确、少叙事。
- 字段说明应该包含类型、是否必填、默认值、支持 Provider、示例。
- CLI 文档应该包含命令、参数、行为、副作用和常见错误。

### 5. 想贡献代码的开发者

入口：

```text
CONTRIBUTING.md
docs/contributing/development.md
docs/contributing/provider-development.md
docs/architecture/how-it-works.md
```

需要回答：

- 如何 clone、install、运行 CLI、启动 WebUI？
- 应该跑哪些测试？
- 工作区 package 边界是什么？
- 新增 Provider 要改哪些文件？
- 哪些改动需要设计说明？
- PR 合并要求是什么？

### 6. 维护者和发布负责人

入口：

```text
MAINTAINERS.md
docs/contributing/release.md
docs/maintainers/open-source-release-checklist.md
```

需要回答：

- 谁可以发布？
- 如何做 release？
- npm package 如何检查？
- GitHub 设置、Scorecard、CodeQL、Dependabot 如何维护？
- 安全报告如何处理？

## 五、现有文档迁移映射

| 当前文件 | 建议目标 | 动作 |
|---|---|---|
| `README.md` | `README.md` | 精简为项目首页 |
| `README.zh-CN.md` | `README.zh-CN.md` | 跟随英文 README 更新 |
| `docs/README.md` | `docs/README.md` | 改为文档导航首页 |
| `docs/configuration.md` | `docs/guides/configure-an-agent.md` + `docs/reference/configuration.md` | 拆分教程和字段参考 |
| `docs/configuration.zh-CN.md` | 对应中文翻译 | 拆分后同步 |
| `docs/providers.md` | `docs/reference/providers.md` | 作为 Provider 能力参考 |
| `docs/providers.zh-CN.md` | `docs/reference/providers.zh-CN.md` | 同步迁移 |
| `docs/how-it-works.md` | `docs/architecture/how-it-works.md` | 作为架构说明 |
| `docs/how-it-works.zh-CN.md` | `docs/architecture/how-it-works.zh-CN.md` | 同步迁移 |
| `examples/README.md` | `examples/README.md` + `docs/examples.md` | 英文化 examples README，docs 中建立索引 |
| `packages/cli/README.md` | 保持原位 | 保持 npm 页面简短说明 |
| `packages/sdk/README.md` | 保持原位 | 保持 npm 页面简短说明 |
| `packages/sdk/docs/release.md` | `docs/contributing/release.md` | 抽取通用发布流程 |
| `packages/sdk/docs/trade-off/*` | `docs/architecture/trade-off/*` 或保持包内 | 仅作为架构历史材料 |
| `docs/open-source-release-checklist.md` | `docs/maintainers/open-source-release-checklist.md` | 移入维护者区域 |
| `docs/launch-*` | `docs/launch/*` | 移入发布传播材料区 |
| `docs/project-proposal.zh-CN.md` | `docs/internal/project-proposal.zh-CN.md` | 移入内部材料区 |

## 六、阶段计划

### Phase 1：开源门面整理

目标：让项目首页和文档首页达到公开发布标准。

任务：

1. 重写 `README.md`，保留清晰定位、最短示例和文档入口。
2. 同步更新 `README.zh-CN.md`。
3. 重写 `docs/README.md`，按读者路径导航。
4. 新增 `docs/getting-started.md`。
5. 新增 `docs/getting-started.zh-CN.md`。
6. 检查 README 中所有链接是否有效。

验收标准：

- 新用户从 README 能在 3 次点击内到达安装、配置、Provider、贡献文档。
- README 不再承担完整 CLI/reference 的职责。
- `docs/README.md` 能清楚区分 Getting Started、Concepts、Guides、Reference、Contributing。

### Phase 2：用户主线文档

目标：把用户从试用带到真实项目接入。

任务：

1. 从 `docs/configuration.md` 提炼 `docs/guides/configure-an-agent.md`。
2. 建立 `docs/concepts/`：
   - `agents-as-code.md`
   - `resources.md`
   - `state-and-drift.md`
   - `sessions-and-deployments.md`
3. 建立 `docs/guides/`：
   - `use-skills.md`
   - `use-mcp-and-vaults.md`
   - `multi-provider.md`
   - `run-sessions.md`
   - `manage-deployments.md`
4. 为 百炼、Qoder、Claude、火山方舟 各补一个 Provider guide。
5. 增加 `docs/examples.md`，按“我要做什么”索引示例。

验收标准：

- 用户能按任务而不是按代码目录找文档。
- 每篇 guide 都有目标、前置条件、步骤、验证方式、下一步。
- Concepts 不和 reference 混写。

### Phase 3：参考文档标准化

目标：把命令、字段、Provider 能力和 API 说明整理成稳定参考。

任务：

1. 建立 `docs/reference/configuration.md`，覆盖 `agents.yaml` 字段。
2. 建立 `docs/reference/cli.md`，覆盖 `agents` 命令。
3. 移动并增强 `docs/reference/providers.md`。
4. 建立 `docs/reference/sdk.md`，链接 package README 和关键 API。
5. 建立 `docs/reference/openapi.md`，说明 `apps/server/openapi.json` 的来源和使用方式。
6. 尽量让参考表格来自源码或测试校验，减少手工漂移。

验收标准：

- 字段、CLI、Provider matrix 都能被用户独立查阅。
- Provider capability 文档和 SDK 声明保持一致。
- reference 不依赖用户读完整教程才能理解。

### Phase 4：贡献者和维护者文档

目标：降低外部贡献门槛，明确扩展和发布流程。

任务：

1. 拆出 `docs/contributing/development.md`。
2. 新增 `docs/contributing/provider-development.md`。
3. 从 SDK release 文档整理 `docs/contributing/release.md`。
4. 移动 `docs/open-source-release-checklist.md` 到 `docs/maintainers/`。
5. 整理 `docs/architecture/`，包括 how-it-works、ADR、重要 trade-off。
6. 在 `CONTRIBUTING.md` 中只保留总览，并链接更详细页面。

验收标准：

- 贡献者能独立完成本地开发、测试、提交 PR。
- 新增 Provider 的步骤清晰可执行。
- 维护者和普通贡献者文档边界明确。

### Phase 5：语言、链接和发布质量

目标：发布前 polish。

任务：

1. 统一英文 canonical 和中文翻译策略。
2. 对所有 Markdown 链接做链接检查。
3. 对命令示例做 smoke test。
4. 统一标题大小写、术语、Provider 名称。
5. 检查所有文档是否误包含内部口吻、未发布承诺或敏感信息。
6. 清理 `.DS_Store` 等不该出现在开源仓库中的文件。

验收标准：

- 新用户路径无断链。
- 示例命令可运行或清楚标注前置条件。
- 内部材料不会混入公开用户文档主路径。
- README、docs 首页、CONTRIBUTING、SECURITY、LICENSE、release checklist 都符合开源发布要求。

## 七、文档写作规范

### 1. 文档类型边界

Guide：

- 面向任务。
- 从一个目标开始。
- 给出步骤和验证方式。
- 示例优先。

Reference：

- 面向查找。
- 字段、命令、参数、默认值、兼容性优先。
- 少叙事，少背景。

Concept：

- 解释心智模型。
- 说明为什么这样设计。
- 不堆完整字段表。

Architecture：

- 面向贡献者和深度用户。
- 可以解释 trade-off、状态机、边界、内部模块。

Launch/Internal：

- 不进入普通用户主路径。
- 可保留，但要明确用途。

### 2. 示例规范

每个 guide 中的示例应尽量满足：

- 使用最小可运行配置。
- 明确需要哪些环境变量。
- 避免真实 secret。
- 提供验证命令。
- 链接到完整 example 目录。

### 3. 术语规范

建议统一以下术语：

- OpenAgentPack
- agents.yaml
- agent
- provider
- resource
- state
- drift
- plan
- apply
- destroy
- session
- deployment
- environment
- vault
- skill
- MCP server
- memory store
- multi-agent

英文文档中不建议混用：

- AI Agent / agent / Agent resource，除非上下文明确。
- deployment / run / session，必须区分声明式资源和运行时行为。
- config / state / remote，必须和 how-it-works 的三源模型保持一致。

## 八、推荐优先级

如果只做开源发布前最关键的部分，建议优先顺序如下：

1. 重写 `README.md`。
2. 重写 `docs/README.md`。
3. 新增 `docs/getting-started.md`。
4. 英文化并整理 `examples/README.md`。
5. 拆分 `configuration.md` 为 guide 和 reference。
6. 增加 `docs/reference/cli.md`。
7. 增加 `docs/contributing/provider-development.md`。
8. 移动 launch/internal/maintainer 材料。
9. 全量链接和命令检查。

## 九、最终期望状态

整理完成后，OpenAgentPack 的文档应该呈现为：

```text
README 是项目首页
docs/README 是文档地图
getting-started 是最短成功路径
concepts 解释核心模型
guides 解决真实任务
reference 提供稳定事实
examples 提供可运行样板
architecture 支撑深度理解
contributing 支撑外部协作
maintainers/internal/launch 不干扰用户路径
```

这样项目会从“准备开源的内部工程仓库”，升级为“外部开发者可以理解、试用、依赖和贡献的开源产品”。

# OpenAgentPack

[English](./README.md) | **简体中文**

> **用 Git 和 YAML 管理、审查并迁移云端 AI Agent。**
>
> 面向托管 AI Agent 的开源 IaC 控制平面。

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@openagentpack/cli?label=npm&color=cb3837)](https://www.npmjs.com/package/@openagentpack/cli)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> [!IMPORTANT]
> OpenAgentPack 目前处于 Beta 阶段。公开 API 和 `agents.yaml` Schema 在 `1.0` 前仍可能发生不兼容变更，详见 [更新日志](./CHANGELOG.md)。

<p align="center">
  <img src="https://img.alicdn.com/imgextra/i1/O1CN016pw0Ax1KuBXckX0Iz_!!6000000001223-2-tps-1254-1254.png" width="360" alt="OpenAgentPack：一份 agents.yaml 管理多个托管 Agent 平台">
</p>

一份 `agents.yaml` 定义 Agent 的环境、模型、指令、工具、技能、MCP、Vault 和凭据。每次变更都能在 PR 中审查，用 `plan` 预览后再执行，不必在控制台里重复搭建同一个 Agent。

- **可审查的 Agent 资产** —— Prompt、工具、Skill 和配置进入 Git，可复用、回滚和交接。
- **可预期的变更** —— `validate → plan → apply` 会在修改远端资源前预览创建、更新和删除。
- **可移植的核心声明** —— 面向百炼、Qoder、Claude和火山方舟，并通过明确的 [Provider 能力契约](./docs/reference/providers.zh-CN.md) 表达差异。

```bash
npm install -g @openagentpack/cli
agents init
# 配置一个 Provider 的凭证后：
agents validate && agents plan
```

[5 分钟快速开始](./docs/getting-started.zh-CN.md) · [查看 Provider 支持](./docs/reference/providers.zh-CN.md) · [浏览可运行示例](./docs/examples.md) · [Roadmap](./ROADMAP.md)

## 为什么是现在

Agent 正在从个人工具变成企业的数字员工。但企业真正重要的东西 —— Prompt、技能、知识文件、工具和运行配置 —— 现在主要只存在于云厂商控制台里。

这些是企业的业务资产。它们不该只活在某个控制台里，而应该像代码、数据和文档一样，可以被管理、被审查、被交接、被复现，也可以自由迁移。

## 为什么用 OpenAgentPack

OpenAgentPack 在 Agent 和云平台之间建立一个声明式控制平面。企业拥有自己的声明，不同平台通过各自的 Adapter，把同一份声明渲染成百炼、Qoder、Claude 或火山方舟中的真实 Agent。

我们的目标，是让 Agent 成为企业可掌控、可迁移、可传承的数字资产。

### 声明与可携带：把 Agent 写成一份图纸

借鉴 Docker 的声明思想，把所有决定 Agent 是什么的东西 —— 模型、指令、工具、技能、环境、文件和凭据引用 —— 收敛到一份 `agents.yaml` 图纸里。这份图纸可以进入 Git、接受 PR 审查、复现 Agent，也可以迁移到不同 Provider。

### 状态与可治理：先计划，再执行

借鉴 Terraform 的状态驱动思想，明确区分期望配置、本地状态和远端状态。`plan` 告诉你即将创建、更新和删除什么；`apply` 按依赖拓扑顺序安全执行；控制台被手动修改后可以发现 Drift；回到之前的稳定声明即可重新收敛。

### 验证与可体验：Agent 的样板间

图纸再精确，也不如走进样板间体验。Playground 从同一份声明运行真实 Session，让团队在不同 Provider 上执行同一个场景。多平台对比不再只是一张能力矩阵，而是可观察、可体验的真实结果。

> OpenAgentPack 借鉴 Docker 的声明思想绘制 Agent 图纸，借鉴 Terraform 的状态驱动思想管理施工与验收，再用 Playground 作为样板间完成效果验证 —— 让企业像管代码一样管 Agent。

具体机制包括一份 `agents.yaml`、`validate → plan → apply` 工作流、内容哈希增量检测、依赖拓扑排序和 Drift 恢复。YAML 始终是事实来源。心智模型见 [Agents as code](./docs/concepts/agents-as-code.md)，精确词汇见 [CONTEXT.md](./CONTEXT.md)。

- **声明式** —— 一个 `agents.yaml` 描述整套 Agent 基础设施。提交它、在 PR 里审查它、随时回滚它。
- **Terraform 式工作流** —— `validate → plan → apply`，每一次 create / update / delete 执行前都能预览。
- **多 Provider** —— 核心声明可复用于百炼、Qoder、Claude 和火山方舟；[能力契约](./docs/reference/providers.zh-CN.md) 会明确表达 native、emulated 和 unsupported 差异。
- **增量变更** —— 基于内容哈希检测差异，只更新真正变化的资源，不做无意义的 API 调用。
- **依赖自动解析** —— Environment → Skill → Agent 按拓扑序创建；依赖失败会跳过下游，而不是留下半成品状态。
- **Drift 恢复** —— 检测远程配置与声明的漂移并收敛回来。YAML 始终是唯一事实来源。

## 效果演示

### CLI 工作流

![OpenAgentPack CLI 工作流](./packages/sdk/docs/agents.gif)

### 本地 Playground

`agents playground` 会启动本地 WebUI，按需拉取匹配版本的 `@openagentpack/playground`，并自动打开浏览器。可通过 `--provider` 指定 `bailian`、`qoder`、`ark` 或 `claude`。

[观看 Playground 演示视频](https://github.com/user-attachments/assets/bf51b8d8-f2ed-464b-bca9-0709fefcc44d)

## 快速开始

```bash
agents init            # 交互式向导生成 agents.yaml
agents validate        # 离线校验，不发起 API 调用
agents plan            # 预览 create / update / delete
agents apply -y        # 执行变更
agents destroy         # 销毁托管资源
```

最小配置：

```yaml
version: "1"

providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}

defaults:
  provider: bailian

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  assistant:
    description: "通用编程助手"
    model: qwen3.7-max
    instructions: |
      你是一个编程助手。
    environment: dev
    tools:
      builtin: [bash, read, glob, grep]
```

密钥通过 `${VAR_NAME}` 语法引用，从 `.env` 加载 —— 绝不写进配置文件本身。完整流程见 [快速开始](./docs/getting-started.zh-CN.md)。

## 安装

全局安装 CLI：

```bash
# 使用 Bun
bun add -g @openagentpack/cli

# 或使用 npm
npm install -g @openagentpack/cli
```

安装后即可使用 `agents` 命令。若想从源码运行，见 [贡献指南](./CONTRIBUTING.md)。

## Provider 支持

| Feature | 百炼 | Qoder | Claude | 火山方舟 |
|---------|:----:|:-----:|:------:|:--------:|
| Environment | native | native | native | native |
| Vault | native | native | native | native |
| Skill | native | native | native | native |
| Agent | native | native | native | native |
| MCP Server | native | native | native | native |
| Memory Store | unsupported | native | unsupported | native |
| Multi-Agent | unsupported | unsupported | native | native |
| Deployment | emulated | emulated | native | emulated |
| Session | native | native | native | native |

完整能力矩阵与各 Provider 差异见 [Provider 参考](./docs/reference/providers.zh-CN.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [快速开始](./docs/getting-started.zh-CN.md) | 从安装到跑通一个 session 的最短路径。 |
| [配置指南](./docs/guides/configure-an-agent.zh-CN.md) | 从最简到完整的渐进式教程。 |
| [配置参考](./docs/reference/configuration.md) | `agents.yaml` 全部字段、类型与说明。 |
| [CLI 参考](./docs/reference/cli.md) | 所有 `agents` 命令、选项与行为。 |
| [Provider 参考](./docs/reference/providers.zh-CN.md) | 能力矩阵与各 Provider 配置。 |
| [工作原理](./docs/architecture/how-it-works.zh-CN.md) | 状态管理、依赖图、增量检测。 |
| [示例](./docs/examples.md) | 按目标索引的可运行配置。 |

[文档首页](./docs/README.md) 按读者目标组织其余内容：概念、指南、参考、架构与贡献。

## 示例

[`examples/`](./examples) 目录包含每个 Provider 的可运行配置，从最简 Agent 到全特性组合（技能、MCP、Vault、多 Agent、Deployment）。建议从 `examples/bailian/basic/` 开始。

## 使用 SDK

CLI 的全部能力都可通过 `@openagentpack/sdk` 以编程方式调用：

```ts
import { resolveProjectConfig, planProjectContext } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

公开 API 见 [SDK 参考](./docs/reference/sdk.md)。

## WebUI

`apps/webui` 是一个 Vite 单页应用，用于浏览 playbook 和驱动 Agent Session；`apps/server` 通过 OpenAPI 暴露 SDK。从仓库根目录同时启动两者：

```bash
bun install
bun run dev        # 同时启动 server + webui
```

或用 `agents playground --provider <bailian|qoder|ark|claude>` 启动打包的本地 UI。

## 参与贡献

欢迎贡献。请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发环境搭建、合并要求以及如何新增 Provider。所有参与者需遵守我们的 [行为准则](./CODE_OF_CONDUCT.md)。

使用 [GitHub Discussions](https://github.com/modelstudioai/OpenAgentPack/discussions) 提问或提交设计建议，使用 [GitHub Issues](https://github.com/modelstudioai/OpenAgentPack/issues) 报告可复现问题和认领已接受任务。当前优先级见 [公开 Roadmap](./ROADMAP.md)。

## 安全

发现漏洞？请按 [SECURITY.md](./SECURITY.md) 的流程处理 —— 不要公开提 issue。

## 许可证

基于 [Apache License, Version 2.0](./LICENSE) 开源。

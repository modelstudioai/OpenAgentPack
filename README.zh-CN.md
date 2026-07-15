# OpenAgentPack

[English](./README.md) | **简体中文**

> **用 Git 和 YAML 管理、审查并迁移云端 AI Agent。**
>
> 面向托管 AI Agent 的开源 IaC 控制平面。

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/modelstudioai/OpenAgentPack/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

<p align="center">
  <img src="https://img.alicdn.com/imgextra/i1/O1CN016pw0Ax1KuBXckX0Iz_!!6000000001223-2-tps-1254-1254.png" width="360" alt="OpenAgentPack：一份 agents.yaml 管理多个托管 Agent 平台">
</p>

一份 `agents.yaml` 定义 Agent 的环境、模型、指令、工具、技能、MCP、Vault 和凭据。每次变更都能在 PR 中审查，用 `plan` 预览后再执行，不必在控制台里重复搭建同一个 Agent。

- **可审查的 Agent 资产** —— Prompt、工具、Skill 和配置进入 Git，可复用、回滚和交接。
- **可预期的变更** —— `validate → plan → apply` 会在修改远端资源前预览创建、更新和删除。
- **可移植的核心声明** —— 面向百炼、Qoder、Claude和火山方舟，并通过明确的 [Provider 能力契约](./docs/reference/providers.zh-CN.md) 表达差异。

```bash
npm install -g @openagentpack/cli
agents init && agents validate && agents plan
```

[5 分钟快速开始](./docs/getting-started.md) · [查看 Provider 支持](./docs/reference/providers.zh-CN.md) · [浏览可运行示例](./docs/examples.md)

## 为什么是现在

Agent Harness 形态正趋于稳定 —— environment、vault、memory、skills、files、MCP servers、prompt、agent loop、multi-agent orchestration。两个趋势并行：Agent 从本地走向远程托管，团队从个人效率走向组织效率（AI Native 组织）。缺的还是一个**稳定可靠、不被厂商锁定的 Agent Infra**。

## 为什么用 OpenAgentPack

你在某个平台上搭了一个 Agent —— 里面有 Prompt、工具、技能、知识文件、凭据、运行设置。这些东西其实是你的业务资产，但今天它们只是一堆控制台里的点击 —— 无法在 PR 里审查、无法回滚、无法复现、无法迁移。当 Agent 从"在自己代码里调模型 API"变成"在厂商控制台里组装 Agent"，厂商锁定往**上一层**重新形成 —— 在 managed harness 层。OpenAgentPack 就是对这个趋势的对抗。

OpenAgentPack 把这些资产变成一份可携带的 Agent 定义，部署到不同的 Agent 平台。你得到三件事：

### 我的 Agent 不被某个平台锁死

今天在百炼，明天可以去 Qoder、Claude、火山方舟，未来也可以接更多平台。

### 我的 Agent 可以复制、迁移、对比

同一个 Agent 可以在多个平台跑，看哪个成本更低、效果更好、速度更快。

### 我的 Agent 是我自己的资产

Prompt、工具、技能、知识文件、配置，不再只是某个控制台里的一堆点击，而是可以保存、复用、审查、交接的东西。

专注业务创新，无须单独人力维护 Agent Infra 基础设施。像 Docker 一样在不同平台间迁移，定义保持不变。

剩下的都是机制：一个 `agents.yaml`、`validate → plan → apply` 工作流、内容哈希增量检测、依赖拓扑排序、Drift 恢复。YAML 始终是唯一事实来源。心智模型见 [Agents as code](./docs/concepts/agents-as-code.md)，精确词汇见 [CONTEXT.md](./CONTEXT.md)（agent harness vs. agent infra、capability contract）。

- **声明式** —— 一个 `agents.yaml` 描述整套 Agent 基础设施。提交它、在 PR 里审查它、随时回滚它。
- **Terraform 式工作流** —— `validate → plan → apply`，每一次 create / update / delete 执行前都能预览。
- **多 Provider** —— 同一份 Agent 定义可部署到百炼、Qoder、Claude和火山方舟，换厂商只改两行。
- **增量变更** —— 基于内容哈希检测差异，只更新真正变化的资源，不做无意义的 API 调用。
- **依赖自动解析** —— Environment → Skill → Agent 按拓扑序创建；依赖失败会跳过下游，而不是留下半成品状态。
- **Drift 恢复** —— 检测远程配置与声明的漂移并收敛回来。YAML 始终是唯一事实来源。

## 效果演示

### CLI 工作流

![OpenAgentPack CLI 工作流](./packages/sdk/docs/agents.gif)

### 本地 Playground

`agents playground` 会启动本地 WebUI，按需拉取匹配版本的 `@openagentpack/playground`，并自动打开浏览器。可通过 `--provider` 指定 `bailian`、`qoder`、`ark` 或 `claude`。

[观看 Playground 演示视频](https://cloud.video.taobao.com/vod/f9cVQvN8vYeW2YfRZ59qv5SgJUDgsm-r48mpKIB0Has.mp4)

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

密钥通过 `${VAR_NAME}` 语法引用，从 `.env` 加载 —— 绝不写进配置文件本身。完整流程见 [Getting started](./docs/getting-started.md)。

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
| [Getting started](./docs/getting-started.md) | 从安装到跑通一个 session 的最短路径。 |
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

## 安全

发现漏洞？请按 [SECURITY.md](./SECURITY.md) 的流程处理 —— 不要公开提 issue。

## 许可证

基于 [Apache License, Version 2.0](./LICENSE) 开源。

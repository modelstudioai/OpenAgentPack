# Getting started（快速开始）

本指南带你在几分钟内从零跑到一个可对话的 Agent session。示例使用百炼，其他 Provider（Qoder、Claude、火山方舟）流程相同，凭证见 [Provider 参考](./reference/providers.zh-CN.md)。

## 前置条件

- 任一 Provider 的账号与 API Key：
  - Claude — `ANTHROPIC_API_KEY`
  - Qoder — `QODER_PAT`
  - 百炼（阿里云百炼 AgentStudio）— `DASHSCOPE_API_KEY` 与 `BAILIAN_WORKSPACE_ID`
  - 火山方舟（火山引擎方舟 Managed Agents）— `ARK_API_KEY`
- 从源码运行需要 [Bun](https://bun.sh) `1.3.5`（见 [开发环境](./contributing/development.md)）；使用发布的 CLI 只需 Node.js 或 Bun。

## 安装

全局安装 CLI：

```bash
# 使用 Bun
bun add -g @openagentpack/cli

# 或使用 npm
npm install -g @openagentpack/cli
```

安装后即可使用 `agents` 命令，验证：

```bash
agents --version
```

## 创建第一个项目

```bash
mkdir my-agents && cd my-agents
agents init
```

init 向导问两个问题 —— 选哪个/哪些 Provider、给第一个 agent 起什么名 —— 然后生成 `agents.yaml`，并把 `agents.state.json` 和 `.env` 加进 `.gitignore`，确保状态和密钥不会被提交。

如果要生成一个由用户自行推送到内部 Codeup 的完整本地仓库，可以直接传目录：

```bash
agents init --git my-agents --provider bailian --agent-name assistant
cd my-agents
```

显式指定 `--git` 后，仓库模式会初始化本地 `main` Git 仓库、跟踪 `agents.state.json`，并生成 `.aoneci/openagentpack-check.yml` 与 `.aoneci/openagentpack.yml`。需要在 Aone 中把检查流水线绑定到 Codeup 合并请求新建/更新事件；它只执行 validate 和基于真实远端状态的 Plan。代码 push 到 `main` 后，部署流水线会 plan、自动 apply 非破坏性的本地变更，并把更新后的 state commit 回 `main`。`agents apply --ci` 策略会阻断删除和远端漂移，这两类变更需要另一条显式审批流程。没有 `--git` 时保持原有当前目录行为，state 仍会被忽略。init 本身不会创建 Codeup 远端或推送 commit。

启用流水线前，需要把 `agents.yaml` 引用的环境变量配置为 Aone 密钥，给 checkout 身份授予 `main` 写权限，把流水线并发度设为 `1`，并在 Aone 中配置合并请求检查或人工审批。Workbench 从本地 `.env` 取值；CI 可以使用相同变量名，但指向另一套 Base URL 和 API Key。

如果此前已经执行过 `agents init`，可以在原项目中补齐仓库能力：

```bash
cd my-agents
agents init --git .
```

该命令会保留 `agents.yaml`、已有 README 和 Aone workflow，创建或保留 `agents.state.json`，从 `.gitignore` 移除 state，增量合并 package 与本地文件 ignore 配置，并且只在 `.git` 不存在时初始化 Git。

为 `bailian` provider、agent 名为 `assistant` 生成的文件如下：

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
    description: "General-purpose assistant"
    model: qwen3.7-max
    instructions: |
      You are a helpful assistant.
    environment: dev
    tools:
      builtin: [bash, read, glob, grep]
```

## 配置凭证

OpenAgentPack 从配置文件旁的 `.env`（向上查找至项目根）解析 `${VAR_NAME}`。创建一个：

```bash
cat > .env <<'EOF'
DASHSCOPE_API_KEY=sk-...
BAILIAN_WORKSPACE_ID=llm-...
EOF
```

绝不把真实 key 写进 `agents.yaml`。`agents init` 写入的 `.gitignore` 条目会确保 `.env` 不进版本控制。

> Claude 加 `ANTHROPIC_API_KEY`；Qoder 加 `QODER_PAT`；火山方舟加 `ARK_API_KEY`。完整字段见 [Provider 参考](./reference/providers.zh-CN.md)。

## 校验

```bash
agents validate
```

`validate` 离线检查 YAML 结构和字段合法性，不发起任何 API 调用。缺少 `model`、未知资源类型或无法解析的 `${VAR}` 都会快速失败。

## 预览变更

```bash
agents plan
```

`plan` 刷新远端状态、对比配置与状态并打印 diff。全新项目一切都是 create：

```text
$ agents plan

  + environment.dev        create
  + agent.assistant         create (depends: environment.dev)

  Plan: 0 to update, 2 to create, 0 to destroy.
```

加 `--provider <name>` 只看某个 Provider，加 `--json` 得到机器可读输出。完整选项见 [CLI 参考](./reference/cli.md)。

## 执行变更

```bash
agents apply        # 会要求确认
agents apply -y     # 跳过确认
```

资源按依赖拓扑序创建 —— 环境在 agent 之前：

```text
$ agents apply -y

  ✓ environment.dev        created
  ✓ agent.assistant        created

  Apply complete. 2 resources managed.
```

## 运行 session

**session** 是从一个已托管 agent 启动的运行时对话。`agents session run` 创建 session、发送 prompt，并默认轮询至响应完成；如需通过 SSE 实时返回事件，请添加 `--stream`：

```bash
agents session run "Summarize the repo structure" --agent assistant
```

其他 session 命令：`session create`、`session list`、`session get`、`session send`、`session events`、`session delete`。见 [运行 session](./guides/run-sessions.md)。

## 清理

```bash
agents destroy
```

`destroy` 销毁所有 OpenAgentPack 托管的资源（不加 `--cascade` 会跳过依赖项）。

## 下一步

- [配置 Agent](./guides/configure-an-agent.zh-CN.md) —— 环境、技能、Vault、MCP、多 Agent。
- [工作原理](./architecture/how-it-works.zh-CN.md) —— 三源模型与 drift 恢复。
- [示例](./examples.md) —— 按目标索引的可运行配置。

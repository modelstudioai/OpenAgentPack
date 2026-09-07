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

init 向导问两个问题 —— 选哪个/哪些 Provider、给第一个 agent 起什么名 —— 然后生成 `agents.yaml`。这是供 `validate → plan → apply` 与 `agents playground` 使用的紧凑 YAML 流程。

如需本地多文件项目和 Workbench，请改用 `agents project init`。它会创建 `project.json`、`agents/assistant/agent.json`、`instructions.md`，并建立不依赖 Git 的全目录基线版本。四类资源目录的 `_examples/` 下会生成完整配置示例和中英文 README；示例不写入 Agent 引用、不进入 Build 或远端 Publish，需要使用时复制到 `_examples/` 外并配置 Agent 引用。目录项目固定使用百炼，因此 `project.json` 不再包含 Provider 配置。Environment、Vault、Memory Store、File 和 Skill 声明放在 Agent 目录（或根共享资源目录），不再写入 `project.json`。对于 Agent 本地内容，Build 会为包含 `SKILL.md` 的目录自动生成 Skill 元数据并写入 Agent 引用；复制到 Agent `files/` 目录的文件可以直接放置，也可以先放入以资源 ID 命名且只含一个内容文件的子目录，Build 都会自动生成 File 元数据和 `/mnt/<文件名>` 挂载。显式 JSON 始终优先。后续使用 `agents project validate`、`project build`、`project publish`、`project workbench` 与 `project version ...`。两套流程明确隔离：传统 YAML Apply 不产生目录版本；project Publish 只使用 `.openagentpack/build/agents.yaml`，且不会隐式执行 Build。

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

目录项目在 Build 时，会把 `vault.json` 中的明文 `secret_value` / `access_token` 移入项目根目录 `.env`，并替换成自动生成的环境变量引用。Preview/dry-run 不写文件。Publish 和 Workbench 读取此 `.env`，优先使用进程中已有的环境变量。`.env` 不进入本地版本快照，也未加密；请自行安全备份并加入 Git 忽略规则。

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

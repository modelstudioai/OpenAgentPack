# 真实 Cloud 探针

`session-threads-live.ts` 只使用 SDK 公开入口验证百炼子 Agent 线程查询，不在普通 `bun test`
中执行。先把凭据通过进程环境注入；脚本不会读取或打印 `.env`，不会输出 Provider 错误正文、
消息正文或凭据。Bun 本身默认加载 `.env`，需要禁止时使用 `bun --no-env-file`。

## Session Threads

先生成计划，不改变远端：

```sh
bun --no-env-file packages/sdk/tests/e2e/session-threads-live.ts
```

计划包含唯一 `kit-e2e-*` 前缀的 worker、coordinator 和 Environment。设置
`KIT_THREAD_ENVIRONMENT_ID` 后复用指定的现有 Environment，只创建两个临时 Agent，
不会修改或清理这个既有 Environment。默认模型 `qwen3.7-max`，可用 `KIT_THREAD_MODEL`
覆盖。所有新资源和 Session 都带 `{ kit: "live-validation", probe: "session-threads", prefix }`。

审阅计划后，显式执行：

```sh
KIT_LIVE=1 bun --no-env-file packages/sdk/tests/e2e/session-threads-live.ts --execute
```

需要 `BAILIAN_API_KEY` 或 `DASHSCOPE_API_KEY`，以及 `BAILIAN_BASE_URL` 或
`BAILIAN_WORKSPACE_ID`。如果需要让审阅与执行使用同一组资源名，两个命令都设置同一个
唯一 `KIT_THREAD_PREFIX=kit-e2e-<timestamp>-<suffix>`。脚本校验计划只包含预期数量的
`create` 动作，并以 `policy: "block"` 拒绝破坏性变更。

执行流程为创建资源 → 创建 Session → 要求 coordinator 委派算术任务 → 等待主会话和
子线程结束 → `listSessionThreads(limit: 1)` → 逐线程
`listSessionThreadEvents(limit: 1, event_format: "snapshot")`。断言包括子线程身份、
主父线程关联、子线程归属、稳定事件 ID、游标续页不重复和实际子 Agent 消息；事件分页必须
跨越至少两页。只产生一个子线程时，线程列表验证末页合同，事件查询负责验证真实续页。

`finally` 中先停止仍在运行的 Session 并删除，再输出本次资源的清理计划，按 coordinator、
worker、Environment 顺序调用 SDK 的清理流程。百炼 Agent 清理按 Provider 协议归档。
若 Environment 因引用关系拒删，SDK 当前没有公开归档入口；脚本报告残留 ID 和临时 state
路径、退出非零，调用方需按正式协议归档并记录结果。任何清理失败都保留 state 供恢复，
成功后删除临时目录。脚本不扫描、不删除其他测试或用户资源。

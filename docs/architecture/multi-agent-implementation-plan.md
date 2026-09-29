# Qoder 与百炼 Multi-Agent 实施计划

> 状态：Ready for implementation  
> 目标读者：接手实现的编码 Agent  
> 调研基线：2026-09-22

> 本文记录最初的项目内逻辑名 Phase 1 基线。后续加入的外部 Managed Agent 引用以
> [Multi-Agent 外部成员引用实施计划](./external-multiagent-member-implementation-plan.md) 为准；其中关于
> “外部成员不支持”和 `unowned` 必须失败的旧约束已被该增量设计取代。

## 目标

让 OpenAgentPack 现有公共配置：

```yaml
multiagent:
  type: coordinator
  agents: [researcher, reviewer]
```

在以下三种远端 materialization 中可预测地工作：

1. Qoder Managed Agent；
2. Qoder Forward Template；
3. 阿里云百炼 Managed Agent。

完成后必须支持：配置校验、依赖排序、引用解析、创建、更新、解除编队、drift 比较、Qoder/Bailian Managed sync/export、文档、示例和自动化测试。

## 开工前必读

按顺序完整阅读：

1. [能力调研与真机证据](../reference/multi-agent-qoder-bailian-research.md)。平台字段、更新语义和限制以该文档为准，不重新猜测。
2. [Provider 开发指南](../contributing/provider-development.md)。
3. [配置参考](../reference/configuration.md)中的 Multi-Agent 配置。
4. 现有 Claude 与 Ark 实现：
   - `packages/sdk/src/internal/providers/claude/mapper.ts`
   - `packages/sdk/src/internal/providers/ark/mapper.ts`
   - `examples/claude/multiagent/agents.yaml`
   - `examples/ark/multiagent/agents.yaml`
5. 当前引用和生命周期代码：
   - `packages/sdk/src/internal/core/validate-config.ts`
   - `packages/sdk/src/internal/graph/dependency.ts`
   - `packages/sdk/src/internal/executor/resolver.ts`
   - `packages/sdk/src/internal/providers/interface.ts`
   - `packages/sdk/src/internal/providers/resource-workflow.ts`
   - `packages/sdk/src/internal/planner/comparable.ts`
   - `packages/sdk/src/internal/planner/refresh.ts`
   - `packages/sdk/src/internal/providers/shared.ts`

官方一手资料：

- [Qoder Multi-Agent 总览](https://docs.qoder.com/cloud-agents/multi-agents)
- [Qoder Managed Agent 创建](https://docs.qoder.com/cloud-agents/api/agents/create)
- [Qoder Managed Agent 更新](https://docs.qoder.com/cloud-agents/api/agents/update)
- [Qoder Forward Template 创建](https://docs.qoder.com/cloud-agents/api/forward/templates/create)
- [Qoder Forward Template 更新](https://docs.qoder.com/cloud-agents/api/forward/templates/update)
- [百炼多智能体协作](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent)
- [百炼创建 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/create)
- [百炼更新 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/update)

## 已冻结的产品决策

实现过程中不得自行改变这些决策。

### 第一阶段范围

包含：

- `type: coordinator`；
- `agents: string[]` 中的项目内逻辑 Agent 名称；
- Qoder Managed、Qoder Forward、百炼；
- 1–20 个普通成员；
- create/update/clear；
- plan/apply/destroy 的依赖顺序；
- drift；
- Qoder Managed 与百炼 Managed 的 sync/export；
- provider capability、文档和示例。

不包含：

- `self`；
- Qoder Advisor；
- 用户显式选择成员数字版本或 `latest`；
- Session Thread list/get/archive/events/interrupt 接口；
- Qoder Forward Template 的 sync/export；当前 `exportResources` 只覆盖 Managed `/agents`，本次不要扩成完整 Forward import 系统；
- 外部/跨项目 Agent ID 引用；
- 嵌套 coordinator。

### 引用与所有权

- YAML 中只接受项目逻辑名称，不接受远端 ID。
- state 中的 `(provider, resource_type, logical_name) -> remote_id` 是 apply/drift 的引用权威。
- sync/export 的反向映射首先使用远端 `agents.resource` ownership metadata；名称只用于展示，不作为身份。
- 无法反向映射时 fail closed：报告诊断并保留现有本地声明，不输出远端 ID，不静默删除 roster。

### 拓扑

- coordinator 不得引用自身；沿用现有 `config.agent.multiagent.self`。
- coordinator 不得引用另一个声明了 `multiagent` 的 Agent。新增 `config.agent.multiagent.nested`。
- 所有直接或间接循环必须在本地校验阶段拒绝。新增 `config.agent.multiagent.cycle`，错误信息必须包含完整循环路径，例如 `lead -> reviewer -> lead`。
- 远端平台是否接受循环与本地规则无关。Qoder Managed/Forward 真机会接受循环；百炼会拒绝循环，但不能依赖远端兜底。

### 版本语义

字符串成员引用使用各 Provider 的原生默认语义：

- Qoder Managed：提交时省略 `version`，平台在 coordinator 保存时固定成员当前数字版本；
- Qoder Forward：使用 `template_id`，没有成员版本字段；
- 百炼：提交时省略 `version`，child Thread 首次创建时解析最新版本，并在该 Thread 生命周期内固定。

第一阶段不尝试抹平上述差异。配置文档必须明确它们。

### 更新与清除

- Qoder Managed create/update roster：`{type:"coordinator",agents:[{type:"agent",id}]}`。
- Qoder Forward create/update roster：`{type:"coordinator",agents:[{type:"agent",template_id}]}`。
- 百炼 create/update roster：`{type:"coordinator",agents:[{type:"agent",id}]}`。
- Qoder Managed/Forward 为 merge update；本地删除 `multiagent` 时更新请求必须显式发送 `multiagent: null`。
- 百炼为全量替换；本地删除 `multiagent` 时更新请求发送 `{type:"coordinator",agents:[]}`，远端读取会归一为 `null`。
- create 请求在未声明 `multiagent` 时省略字段。

### Drift

- 本地字符串逻辑名和远端对象引用必须先转为同一种 canonical comparable，再比较。
- 成员身份按远端 ID比较；Qoder Forward 的成员 `name` 不参与比较。
- Qoder 自动回填的数字版本不产生永久 drift；第一阶段将其视为平台保存快照，而不是用户声明。
- 百炼 `version:null` 与本地省略版本等价。
- roster 按配置顺序保存，但 drift 比较按成员身份集合比较。当前没有平台契约证明 roster 顺序影响路由。

## 目标内部模型

在 `packages/sdk/src/internal/multiagent/` 新建纯逻辑模块。推荐文件：

```text
packages/sdk/src/internal/multiagent/
├── model.ts
├── topology.ts
├── comparable.ts
└── reverse-index.ts
```

使用以下内部类型；名字可以按仓库惯例微调，语义不得改变：

```ts
export interface ResolvedMultiagentMember {
  logical_name: string;
  resource_type: "agent" | "template";
  remote_id: string;
}

export interface ResolvedMultiagentRoster {
  type: "coordinator";
  members: ResolvedMultiagentMember[];
}

export interface ComparableMultiagentRoster {
  type: "coordinator";
  member_ids: string[]; // sorted, unique
}
```

`ResolvedAgentRefs` 不再只携带裸 `multiagent_agent_ids?: string[]`。替换为能保留逻辑名和资源类型的 roster：

```ts
multiagent?: ResolvedMultiagentRoster;
```

这是内部破坏性修改；一次性更新 Claude、Ark、Qoder、Bailian mapper 和相关测试，不保留双字段兼容层。

## 执行步骤

每一步都必须达到完成条件后再继续。

### 1. 先锁定测试矩阵

新增或扩展以下测试：

- `packages/sdk/tests/unit/multiagent-topology.test.ts`
- `packages/sdk/tests/unit/multiagent-comparable.test.ts`
- `packages/sdk/tests/unit/resolve-from-object.test.ts` 或新建 `multiagent-resolver.test.ts`
- `packages/sdk/tests/unit/qoder-examples.test.ts`
- `packages/sdk/tests/unit/qoder-forward-template.test.ts`
- `packages/sdk/tests/unit/bailian.test.ts`
- `packages/sdk/tests/unit/ark-provider.test.ts`
- Claude mapper 对应的现有测试；用 `rg "mapAgent" packages/sdk/tests` 定位，不另造重复测试文件。
- `packages/sdk/tests/unit/provider-conformance.test.ts`
- 必要时扩展 `packages/sdk/tests/unit/drift-detection.test.ts` 与 `executor-drift-baseline.test.ts`。
- Qoder/Bailian Adapter HTTP 路由契约继续放在现有 `packages/sdk/tests/e2e/*adapter*.test.ts`，这些是 mock HTTP 测试，不是真机测试。

首先写出失败测试，至少覆盖：

1. 未知成员；
2. 自引用；
3. coordinator 引用 coordinator；
4. 两节点和三节点循环；
5. 同成员重复出现；
6. 0 个和 21 个成员；
7. Managed 引用解析为 `agent` ID；
8. Forward 引用解析为 `template` ID；
9. 缺失远端 ID时抛出 `UserError`，不跳过；
10. 三种 Provider payload；
11. 三种 clear payload；
12. Qoder toolset 恰好出现一次；
13. Qoder 自动版本和百炼 `null` 版本不产生 drift；
14. reverse mapping 成功、unresolved、archived、unowned；
15. 依赖顺序为成员先于 coordinator，销毁顺序相反。

完成条件：新增测试能够编译，且因为目标行为尚未实现而失败；失败原因与预期行为一致。

### 2. 收紧公共 Schema 与配置校验

修改：

- `packages/sdk/src/internal/parser/schema.ts`
- `packages/sdk/src/internal/core/validate-config.ts`

规则：

- `multiagent.agents` 在公共 parser 使用 `.min(1)`；Qoder/Bailian 的 20 成员上限放在 provider-aware validation，避免把两家的当前限制错误施加给其他 Provider；
- 同一 roster 内名称唯一；
- 保留 unknown/self 检查；
- 增加 nested 检查；
- 对全部 Agent 构造有向图并检测循环，输出完整循环路径；
- 删除 `qoder.template.multiagent.unsupported`；Forward 已由官方与真机确认支持；
- capability 校验只在实际 materialization 支持时放行。Qoder Managed/Forward、百炼 Managed 均放行。

循环检测放进 `internal/multiagent/topology.ts`，`validate-config.ts` 只负责把诊断写入现有 diagnostics 接口。

完成条件：拓扑测试全部通过；错误 code 和错误消息稳定，不依赖对象遍历偶然顺序。

### 3. 建立 materialization-aware 引用解析

修改：

- `packages/sdk/src/internal/providers/interface.ts`
- `packages/sdk/src/internal/executor/resolver.ts`
- 使用现有 `resolveAgentMaterialization`，不要复制 delivery 判断。

行为：

- `resolveAgentRefs` 为 Managed coordinator 解析成员的 `agent` state 地址；
- `resolveTemplateRefs` 为 Forward coordinator 解析成员的 `template` state 地址；
- 每个声明成员必须通过 `requireRef`；删除当前 `if (id) push` 的静默跳过行为；
- roster 保留 `logical_name`、`resource_type`、`remote_id`；
- Claude、Ark 继续从新 roster 取 `remote_id`，保持现有 wire 格式。

不要让 `resolveTemplateRefs` 直接复用会解析 `agent` 地址的 Multi-Agent 部分。可提取共享的 Skill refs，再分别解析 Managed/Forward roster。

完成条件：Managed/Forward resolver 测试通过；任何缺失成员都会在发请求前失败。

### 4. 实现 Provider wire mapping

#### Qoder Managed

修改 `packages/sdk/src/internal/providers/qoder/mapper.ts`：

- create/update body 有 roster 时输出：

  ```ts
  {
    type: "coordinator",
    agents: refs.multiagent.members.map(({ remote_id }) => ({
      type: "agent",
      id: remote_id,
    })),
  }
  ```

- 保留现有唯一的 `agent_toolset_20260401`；不另加第二个 toolset；
- `agentToDecl` 暂时只在拿到 reverse index 时恢复逻辑名称，见步骤 7。

#### Qoder Forward

修改 `mapForwardTemplate`：

```ts
{
  type: "coordinator",
  agents: refs.multiagent.members.map(({ remote_id }) => ({
    type: "agent",
    template_id: remote_id,
  })),
}
```

不要发送 Managed 的 `id` 或 `version`，不要依赖远端成员 `name`。

#### 百炼

修改 `packages/sdk/src/internal/providers/bailian/mapper.ts`：

```ts
{
  type: "coordinator",
  agents: refs.multiagent.members.map(({ remote_id }) => ({
    type: "agent",
    id: remote_id,
  })),
}
```

省略 `version`，保持真机已证实的 child Thread 首次创建时解析语义。

完成条件：所有 mapper 测试通过，三个 wire payload 与调研报告完全一致。

### 5. 分离 create 与 update 的 clear 语义

当前 mapper 同时服务 create/update，而“本地未声明”在 create 是省略、在 update 可能是清除。必须显式传入操作上下文，推荐：

```ts
type MappingOperation = "create" | "update";
```

将 operation 传入 `mapAgent` / `mapForwardTemplate`，或新增 `mapAgentUpdate` 包装函数。选择改动较小的一种，但必须满足：

- create + no multiagent → 字段不存在；
- Qoder Managed update + no multiagent → `multiagent: null`；
- Qoder Forward update + no multiagent → `multiagent: null`；
- Bailian update + no multiagent → `{type:"coordinator",agents:[]}`；
- Bailian create + no multiagent → 字段不存在。

更新：

- Qoder/Bailian Adapter 的 create/update 调用；
- `normalizeDesiredResource` 调用时使用 create-style canonical desired，不把 clear sentinel 当成最终状态；
- 所有 mapper 调用测试。

完成条件：clear 契约测试通过；从有 roster 更新到无 roster 后，下一次读取的 comparable 为无 roster。

### 6. 启用 capability 和依赖图

修改：

- `packages/sdk/src/internal/providers/qoder/capabilities.ts`
- `packages/sdk/src/internal/providers/bailian/capabilities.ts`
- `packages/sdk/src/internal/graph/dependency.ts`
- `packages/sdk/tests/unit/provider-conformance.test.ts`

设置：

```ts
multiagent: { tier: "native", reason: "coordinator + roster topology" }
```

依赖图必须使用 `resolveAgentMaterialization(provider, subDecl)` 决定成员节点是 `agent` 还是 `template`。不要只根据 coordinator 自身的 materialization 假设成员类型；第一阶段要求同一 roster 的成员与 coordinator 在同一 Provider 下可解析为各自声明的 materialization，且 Qoder Forward coordinator 的成员必须是 Forward Template。若成员 materialization 不匹配，校验阶段产生：

```text
qoder.template.multiagent.member_materialization
```

第一阶段的明确规则：

- Qoder Managed coordinator 只能引用 Qoder Managed Agent；
- Qoder Forward coordinator 只能引用 Qoder Forward Template；
- 百炼只有 Managed Agent；
- Claude/Ark 保持现状。

完成条件：plan 创建层级先成员后 coordinator；destroy 反向；混合 materialization 在 plan 前失败。

### 7. 实现 semantic drift

新增 `internal/multiagent/comparable.ts`，集中处理：

```ts
canonicalizeDesiredRoster(resolvedRoster)
canonicalizeRemoteRoster(rawMultiagent, materialization)
```

规范：

- 输出 `member_ids` 去重并排序；
- Managed 读取 `id`；Forward 读取 `template_id`；
- 忽略 Qoder Forward `name`；
- 忽略第一阶段不可声明的远端成员版本；
- `null`、缺失和空 roster 统一为 `undefined`；
- 遇到 `self`、Advisor 或未知成员类型时返回 unsupported diagnostic，不把它们静默当成普通 Agent。

现有 `normalizeDesiredResource(type,name,decl)` 拿不到 resolved refs。不要在 mapper 内通过名称猜远端 ID。扩展 drift seam，让 planner 在已有 `config + state + address` 的位置先调用 resolver，并把 resolved refs 传给 Provider 的 desired normalization。推荐将可选第四参数加入接口：

```ts
normalizeDesiredResource(
  type: ResourceType,
  name: string,
  decl: unknown,
  refs?: ResolvedAgentRefs | ResolvedTemplateRefs,
): unknown | null;
```

调用方只对 `agent`/`template` 计算 refs，其他资源行为不变。同步更新 `resource-workflow.ts` 与所有 fake Adapter。

完成条件：连续两次 refresh/plan 不产生永久 Multi-Agent drift；远端成员被手工替换或删除时产生 drift。

### 8. 实现 Managed sync/export 的安全 reverse mapping

修改：

- `packages/sdk/src/internal/providers/shared.ts`
- Qoder/Bailian/Claude/Ark 的 `agentToDecl` 函数签名和调用；
- 对应 export/sync 测试。

为 `/agents` 完整清单建立一次 index：

```ts
remote agent id -> {
  logical_name,
  archived,
  owned,
}
```

`logical_name` 只从 metadata 中显式存在的 `agents.resource` 得到，并同时校验 `agents.project` 与当前项目相同。不要调用会回退到展示名称或 ID 的 helper，也不要使用 coordinator roster 中的 `name`。

扩展 `agentToDecl` 接收 resolver：

```ts
agentToDecl(raw, resolveMemberName)
```

策略：

- 全部成员可映射 → 输出字符串逻辑名 roster；
- 成员归档 → `sync.multiagent.member.archived`；
- 成员未归属本项目 → `sync.multiagent.member.unowned`；
- 远端 ID 不在清单或无法读取 → `sync.multiagent.member.unresolved`；
- 多个本地资源映射同一 ID → `sync.multiagent.member.ambiguous`。

当前 `ExportedResource` 没有 diagnostics 通道。不要吞错。采用仓库现有 sync 错误风格：若没有可复用的结构化诊断返回类型，抛出带上述稳定 code 文本的 `UserError`，使 sync 在写文件前终止。确认 `sync-runtime.ts` 先收集再写入；若不是原子写入，先修成“全部 export 成功后再写”。

Qoder Forward Template sync/export 保持非目标；不得从 Managed `/agents` 索引推断 Template。

完成条件：成功 reverse 后 YAML 只含逻辑名称；四类失败均不改写现有文件。

### 9. 文档与示例

新增：

- `examples/qoder/multiagent/agents.yaml`：Managed 示例；
- `examples/qoder/multiagent-forward/agents.yaml`：Forward 示例；
- `examples/bailian/multiagent/agents.yaml`。

更新：

- `examples/README.md`
- `docs/examples.md`
- `docs/concepts/resources.md`
- `docs/guides/configure-an-agent.md`
- `docs/guides/configure-an-agent.zh-CN.md`
- `docs/guides/deploy-to-qoder.md`
- `docs/guides/deploy-to-bailian.md`
- `docs/reference/configuration.md`
- `docs/reference/providers.md`
- `docs/reference/providers.zh-CN.md`
- 新增一条 `.changeset/*.md`，覆盖 SDK/CLI 用户可见的 Provider capability 变化；按仓库现有 changeset 格式选择版本级别。

文档必须说明：

- 只支持项目内逻辑名称；
- 第一阶段禁止嵌套和循环；
- 三种 materialization 的版本语义；
- Qoder/百炼 clear 差异由 Adapter 隐藏；
- 百炼 child 可并行且共享文件系统，coordinator instructions 应声明文件所有权；
- `self`、Advisor、显式版本和 Thread 管理尚未由公共 Schema 暴露。

完成条件：示例通过现有 parser/validate 测试；中英文能力矩阵一致。

### 10. 验证与真机回归

本地验证按顺序运行：

```bash
bun test packages/sdk/tests/unit/multiagent-topology.test.ts
bun test packages/sdk/tests/unit/multiagent-comparable.test.ts
bun test packages/sdk/tests/unit/qoder-examples.test.ts
bun test packages/sdk/tests/unit/qoder-forward-template.test.ts
bun test packages/sdk/tests/unit/bailian.test.ts
bun test packages/sdk/tests/unit/provider-conformance.test.ts
bun run typecheck:sdk
bun run lint:changed
bun run verify:scoped
git diff --check
```

如果测试文件最终名称不同，使用等价的新路径；不要跳过相应行为。

凭据存在时，新增一个显式 opt-in 的 live probe，默认测试套件不得调用生产 API。建议：

```text
packages/sdk/tests/e2e/multiagent-live.ts
```

通过参数选择 `qoder-managed`、`qoder-forward`、`bailian`。要求：

- 名称使用 `oap-ma-live-${timestamp}`；
- Qoder 临时资源最终 DELETE/archive；
- 百炼 Agent 最终 archive，Session/Environment 删除；
- `finally` 中清理；
- 日志不输出 token、完整用户 metadata 或非测试资源清单；
- 只验证一个 worker + coordinator 的创建、读取、运行、清除和清理；不要把研究阶段的循环测试放入日常 live probe。

完成条件：三个模式至少各人工执行一次并保存脱敏结果；所有临时资源已清理。

## 验收清单

实现只有在以下全部成立时完成：

- [ ] Qoder Managed、Qoder Forward、百炼都能从同一公共 YAML 创建 coordinator。
- [ ] 三者请求体字段正确：Managed/Bailian 用 `id`，Forward 用 `template_id`。
- [ ] Qoder `agent_toolset_20260401` 恰好出现一次。
- [ ] 删除本地 `multiagent` 后远端 roster 被解除。
- [ ] 未知、缺失、嵌套和循环引用在网络请求前失败。
- [ ] 成员创建先于 coordinator；销毁顺序相反。
- [ ] 连续 plan 无永久 drift。
- [ ] 远端手工替换成员会产生 drift。
- [ ] Managed sync/export 输出逻辑名称，不输出远端 ID。
- [ ] unresolved/archived/unowned/ambiguous reverse 均 fail closed 且不改文件。
- [ ] Qoder/Bailian capability 不再显示 unsupported。
- [ ] Claude/Ark 现有 Multi-Agent 测试无回归。
- [ ] 文档、示例、中英文能力矩阵已更新。
- [ ] scoped verification、typecheck、lint 和 diff check 全部通过。
- [ ] live probe 的临时资源全部清理。

## 不得采用的捷径

- 直接把远端 ID 写入 `agents.yaml`；
- 在 resolver 找不到成员时跳过它；
- 用远端展示名称代替 ownership metadata；
- 用一个 Qoder payload 同时处理 Managed 与 Forward；
- 仅修改 capability 而不补 mapper、clear、drift 和 reverse；
- 让 Adapter 外的调用方知道 `null` 与空 roster 的 Provider 差异；
- 依赖 Qoder 或百炼服务端检测循环；
- 看到远端自动版本字段就永久报告 drift；
- 将真机循环/嵌套探针加入默认测试套件。

## 实施完成后的交付说明

最终回复必须包含：

1. 支持矩阵：Qoder Managed、Qoder Forward、百炼分别实现了什么；
2. 公共 Schema 是否变化；
3. clear、版本和 reverse mapping 的实际语义；
4. 修改文件与新增示例；
5. 执行过的测试和结果；
6. live probe 是否运行以及资源清理结果；
7. 仍然明确排除的 `self`、Advisor、显式版本和 Thread 管理。

# Qoder 与百炼 Multi-Agent 能力调研

> 调研日期：2026-09-22  
> 范围：Qoder Cloud Agents 与阿里云百炼 Agent Studio 的官方 Multi-Agent 文档，以及 OpenAgentPack 当前实现。平台能力与仓库实现能力分开陈述。

## 结论摘要

Qoder 和百炼目前都原生提供 `coordinator` 编队，因此 OpenAgentPack 中两者仍标记为 `unsupported` 的能力矩阵已经过时，应改为支持。

- **Qoder 是完整的多 Agent 运行时模型，且 Managed Mode 与 Forward Mode 都有官方契约**：Managed Agent roster 通过 `id`/`version` 引用 Agent；Forward Template roster 通过 `template_id` 引用另一个 Template，两种模式不能共用同一请求映射。协调者将工作委派给独立 Session Thread，子 Agent 可拥有各自的模型、提示词、工具、MCP 与 Skill；线程上下文隔离但共享环境、沙箱和文件系统；平台还定义了 Advisor、线程事件流、单线程中断、工具确认和清晰的数量/深度限制。[Qoder：How it works](https://docs.qoder.com/cloud-agents/multi-agents#how-it-works)
- **百炼的多智能体配置页主要给出 roster 契约，Session/Event 与 Webhook API 补充了部分运行时契约，真机进一步证实了独立 child Thread、并行执行和 Session 内共享文件系统**：支持 `coordinator`，成员为另一个 Agent 或 coordinator 自身，条目数最多 20；事件可携带 child Thread 标识并支持定向中断。公开 API 仍没有完整 Thread CRUD。[百炼：编队配置](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E7%BC%96%E9%98%9F%E9%85%8D%E7%BD%AE)；[百炼：发送 Event](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/session/send-event)
- 因此，第一阶段可以让两个 provider 都支持 OpenAgentPack 已有的最小公共模型 `multiagent: { type: coordinator, agents: string[] }`；Qoder 的 Advisor、`self`、版本选择和 Thread API 不应被误称为已经由该公共模型覆盖。
- 多 Agent 是否真正发生由 coordinator 的系统提示词与运行时判断决定。仅配置 roster 不保证委派；至少 Qoder 官方明确说明 coordinator 仍会自主决定是否及如何委派。[Qoder：Create and run a Session](https://docs.qoder.com/cloud-agents/multi-agents#create-and-run-a-session)

## 能力对比

| 维度 | Qoder Cloud Agents | 阿里云百炼 Agent Studio | 对 OpenAgentPack 的含义 |
|---|---|---|---|
| 概念模型 | 一个 Session 中有唯一 coordinator；普通成员在独立 Session Thread 中执行；还可配置只提供意见、不执行工具的 Advisor。[来源](https://docs.qoder.com/cloud-agents/multi-agents#how-it-works) | 一个 `coordinator` 编排成员 Agent；不配置 `multiagent` 或清空编队时按单 Agent 运行。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent) | 两者的最小交集是 coordinator + roster。Advisor 仅能作为 Qoder 扩展。 |
| 角色与编排 | coordinator 负责拆解、选人、追问、汇总；child Agent 可有独立模型、提示词、工具、MCP、Skill；Advisor 只能建议。[来源](https://docs.qoder.com/cloud-agents/multi-agents#how-it-works) | 成员类型为 `agent` 或 `self`；当前只支持 `coordinator` 拓扑。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E7%BC%96%E9%98%9F%E9%85%8D%E7%BD%AE) | 当前公共 schema 能表达引用其他逻辑 Agent，但不能表达 `self`、Advisor 或成员版本。 |
| 任务分发 | coordinator 根据 system prompt 从 `multiagent.agents` 选择成员；官方建议明确任务拆分、委派标准、输出格式和冲突处理。[来源](https://docs.qoder.com/cloud-agents/multi-agents#what-to-delegate) | 本页只说明 coordinator “编排”成员，没有公开选择算法、任务消息或冲突处理契约。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent) | 应把职责与委派规则写入 coordinator 的 `instructions`；不能由配置 roster 推断固定路由。 |
| 上下文与状态 | 每个 Thread 有独立对话历史、Agent 版本快照和状态；线程共享 Environment、Sandbox、文件系统，Session 绑定的 Vault 可供获权 Agent 使用。[来源](https://docs.qoder.com/cloud-agents/multi-agents#how-it-works) | 真机事件为两个 child 返回不同 `sthr` ID；worker A 写入 `/mnt/data/oap_shared_probe.txt` 后，worker B 成功读出 `SHARED_TOKEN_7391`，证明该 Session 的 child 共享文件系统。 | 两端都应按独立 Thread、共享文件系统处理；不同 Thread ID直接证明执行线程隔离，但单次实验本身不能完整证明所有内存态或对话内容绝不会跨线程泄露。 |
| 版本快照 | 数字版本用于固定复现；`latest` 让新 Session 采用最新子 Agent；省略版本会在保存 coordinator 时固定当时版本；既有 Session 继续使用原快照。[来源](https://docs.qoder.com/cloud-agents/multi-agents#agent-versions-and-session-snapshots) | `type=agent` 省略版本时，coordinator 保存值保持 `null`。真机在 worker v1 时创建 Session A但不发消息，更新 worker 到 v2 后首次委派，child 明确回显 `version:2`；再更新到 v3 后，同一 Session 再次委派复用同一 `sthr` 且仍为 v2。 | 两端省略 version 语义不同：Qoder 保存 coordinator 时固化数字版本；百炼在 child Thread 首次创建/执行时解析最新版本，并在该 Thread 生命周期内固定，不会每次调用重新解析。 |
| 工具、MCP 与权限 | 普通成员或 `self` 要求 coordinator 启用 `agent_toolset_20260401`；每个 Thread 使用自身 Agent 快照中的工具与权限。MCP/Skill 属于 Agent；Vault 属于 Session。需要确认的调用通过事件暂停，并用 tool-use ID 路由回复。[配置来源](https://docs.qoder.com/cloud-agents/multi-agents#configure-with-the-api)；[权限来源](https://docs.qoder.com/cloud-agents/multi-agents#tool-permissions-and-interactions) | 本页的 Multi-Agent 示例没有声明额外 toolset，也未说明成员工具、MCP、密钥与权限继承规则。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E9%85%8D%E7%BD%AE%E7%A4%BA%E4%BE%8B) | Qoder 现有 mapper 已始终输出该 toolset；接入 roster 时须保留并补测试。百炼不要臆造相同要求。高权限凭据应只配给需要它的 Agent。 |
| 并行与串行 | 支持独立任务并行，也支持实现→评审等分阶段串行；并行线程共享文件系统，官方要求明确文件/目录所有权。[来源](https://docs.qoder.com/cloud-agents/multi-agents#what-to-delegate) | 真机中两个 child Thread 在约 130 ms 内创建并同时进入 `running`；两边 `sleep 6` 的 shell 时间戳均为 start `1790067744`、end `1790067750`，证明该次运行确实并行。 | 可以确认百炼具备并行执行能力，但单次实验不能推出固定调度顺序、并发上限或所有任务必然并行；共享文件仍需明确所有权。 |
| 可观测性 | Session SSE 展示主线程与跨线程协作事件；Thread API 可列出线程并读取单线程完整事件流。事件包括 thread created/running/rescheduled/idle/terminated 及消息收发。[来源](https://docs.qoder.com/cloud-agents/multi-agents#observe-threads-and-events) | Session 事件 `metadata` 可带 `thread_id`；Webhook 定义四类 Thread 生命周期事件并返回 `session_thread_id`；发送 Event 支持按该 ID 定向中断。公开索引未提供 Thread list/get/archive 或逐 Thread 历史端点。[Webhook 来源](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/callback) | 当前统一事件已有 `session_thread_id`，但 ProviderAdapter 没有 Thread 查询接口。第一阶段可保留事件元数据和定向中断；完整 Thread 管理仍是 Qoder 特有 facet。 |
| 人机协作 | 可按 `session_thread_id` 中断单线程；需确认/自定义工具调用会进入 `requires_action`，客户端必须逐一响应未决事件；Advisor 失败不阻断主任务。[中断](https://docs.qoder.com/cloud-agents/multi-agents#interrupt-one-thread)；[工具交互](https://docs.qoder.com/cloud-agents/multi-agents#tool-permissions-and-interactions)；[Advisor 失败](https://docs.qoder.com/cloud-agents/multi-agents#events-and-failures) | 本页没有 Multi-Agent 专属的人机介入、暂停、审批或恢复说明。 | Qoder 的 `requires_action` 不能被 UI 当作完成态；工具回复按 tool-use ID 路由，不应附 thread ID。 |
| 限制 | 最多 20 个不同普通成员 + 1 Advisor；每 Session 最多 25 个未归档普通 Thread（含 coordinator）；只有 coordinator 能创建子线程，不能嵌套委派；普通成员/`self` 需要指定 toolset。[来源](https://docs.qoder.com/cloud-agents/multi-agents#limits) | 编队条目 1–20；`self` 最多一个；`agent.id` 最长 64 字符；清空数组用于取消编队；当前仅有 coordinator 拓扑。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E7%BC%96%E9%98%9F%E9%85%8D%E7%BD%AE) | parser 可提前校验 roster 数量，但 provider 特有规则应留在 provider 映射/校验层。 |
| 适用场景 | 独立调研、按模块实现、数据收集、实现/测试/评审分工、需要更强模型或专用工具的路由、分阶段迭代。[来源](https://docs.qoder.com/cloud-agents/multi-agents#what-to-delegate) | 本页只给出 coordinator + researcher 配置示例，没有列举更细场景。[来源](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E9%85%8D%E7%BD%AE%E7%A4%BA%E4%BE%8B) | 适合可按职责边界拆分的复杂任务；一步任务、强顺序任务和多人频繁修改同一文件的任务优先单 Agent。 |

## 关键配置差异

### 已证实 / 待真机验证矩阵

下表将官方文档和本次隔离真机测试证实的契约，与证据仍有边界的行为分开。实现不得把单次运行结果外推成平台未承诺的普遍保证。本次真机测试没有在报告中记录任何凭据；临时 Qoder 资源已删除，百炼 Agent 已归档、Environment 与 Session 已删除。

| 问题 | Qoder Managed Mode | Qoder Forward Mode | 百炼 Managed Agents | 实施结论 |
|---|---|---|---|---|
| 适用资源 | **文档已证实**：`Agent.multiagent`，创建 `POST /api/v1/cloud/agents`。[创建 Agent](https://docs.qoder.com/cloud-agents/api/agents/create) | **文档已证实**：`Template.multiagent`，创建 `POST /api/v1/forward/templates`；成员引用使用 `template_id`。[创建 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/create) | **文档已证实**：Agent 创建/更新 API 的 `multiagent` 字段。[创建 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/create) | 第一阶段必须先声明 Qoder materialization 是 Managed Agent 还是 Forward Template；不能只把 capability 全局改成 `native` 后复用同一 mapper。 |
| 创建 roster | **文档和真机均已证实**：`{type:"coordinator",agents:[{type:"agent",id,version?},{type:"self"}, advisor?]}`；真机以省略成员 version 的对象创建 worker + coordinator 成功。 | **文档已证实**：`{type:"coordinator",agents:[{type:"agent",template_id,name?},{type:"self"}, advisor?]}`；普通成员没有 Managed 的 `version` 字段。[Template 创建](https://docs.qoder.com/cloud-agents/api/forward/templates/create#multiagent) | **文档和真机均已证实**：`{type:"coordinator",agents:[{type:"agent",id,version?},{type:"self"}]}`，1–20 项；真机创建 worker + coordinator 成功。 | Provider 内要按 materialization 分支生成对象，禁止把逻辑名或远端 ID 字符串混入错误资源类型。 |
| 更新 / 清除 | **文档和真机均已证实**：更新是 merge update，`version` 必填作 OCC；省略 `multiagent` 保留，`multiagent:null` 清除。真机传 `agents:[]` 返回 400，传 `multiagent:null` 成功且 GET 为 `null`。[更新 Agent](https://docs.qoder.com/cloud-agents/api/agents/update) | **文档和真机均已证实**：`POST /templates/{id}` 为 merge update；真机确认省略 `multiagent` 保留、对象整体替换成功、`null` 清除；成员 `name` 按调用方提交值原样回显。[更新 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/update) | **文档和真机均已证实**：更新是全量替换，`version` 必填作 OCC，缺省字段视为清空；真机传 `{type:"coordinator",agents:[]}` 成功且 GET `multiagent:null`。[更新 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/update) | 两端不能共用 patch 策略。百炼更新必须构造完整 Agent 配置，避免无关字段被清空；Qoder Managed 与 Forward 删除 roster 都传 `multiagent:null`。Forward 的 `name` 是调用方数据，不能据此假定它是 OpenAgentPack 逻辑键。 |
| 成员 `version` 省略 | **文档和真机均已证实**：保存 coordinator 时解析并固定为成员当前数字版本；真机请求只传 `{type:"agent",id}`，GET 自动回显 `version:1`。只有显式 `"latest"` 才让未来新 Session 采用当时最新版本。[Schema](https://docs.qoder.com/cloud-agents/api/agents/schemas#multiagent-agent-entry) | **文档已证实**：成员按 `template_id` 引用，公开 Template roster 契约不提供成员 `version`。 | **真机已精确证实时点**：worker v1 时先创建未运行的 Session A；更新到 v2 后首次委派，child 回显同一 worker 的 `id/name/version:2`，排除 Session 创建时解析。再更新到 v3 后于同一 Session 再次委派，复用同一 `sthr` 且仍回显 v2，证明 child Thread 创建后版本固定。 | 百炼 `null` 表示在 child Thread 首次创建/执行时解析最新版本，并在该 Thread 内固定；reverse 不能伪造成 coordinator 保存时已经固定的数字版本。 |
| Toolset | **文档和真机均已证实**：普通成员或 `self` roster 需要 `agent_toolset_20260401`；真机 GET 回显该 toolset。 | **文档已证实**：普通成员或 `self` 同样需要该 toolset，且 Forward 创建 Template 会自动添加。[创建 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/create#multiagent) | **未发现等价要求**。 | Qoder mapper 和测试必须保留 toolset；百炼不得臆造同一字段。 |
| 读取 / reverse 形状 | **文档和真机已证实**：GET 返回完整 `multiagent`，成员为远端 `id` + 保存后的 `version`，没有 OpenAgentPack 逻辑名；调用方传的 `name` 会被忽略。[Schema](https://docs.qoder.com/cloud-agents/api/agents/schemas#multiagent-agent-entry) | **文档已证实**：Template 使用 `template_id`，可含展示 `name`；不能假定该名称就是 OpenAgentPack 逻辑键。[获取 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/get) | **文档和真机已证实**：GET/List 返回完整 `multiagent`，成员为 `{type,id,version}`；省略 version 的真机响应为 `null`，没有成员逻辑名。[获取 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/get) | reverse mapper 必须用同一 workspace 资源清单建立 `remote id -> local logical name` 索引；无法映射时应保留 unresolved reference 或报错，不能静默丢弃。 |
| 嵌套 / 循环 | **真机已证实配置层宽松**：保存 coordinator→coordinator 成功；保存 A↔B 直接循环也成功。运行时文档仍规定只有根 coordinator Thread 能创建 child、不能嵌套委派。[限制](https://docs.qoder.com/cloud-agents/multi-agents#limits) | **真机已证实配置层同样宽松**：保存 A↔B Template 直接循环成功。 | **真机已证实**：保存 coordinator→coordinator 成功；建立 A↔B 时第二条边返回 HTTP 400、`AGENT_010`。无环 outer→inner→worker 运行仅创建 inner 的一个 child Thread，没有 worker 的第二个 `sthr`，inner 自身返回结果，未发生二级委派。 | OpenAgentPack 必须在本地拒绝所有循环；Qoder Managed/Forward 不能依赖平台，百炼错误也只是额外防线。百炼单次运行不能证明永远不支持递归编排，但足以支持第一期统一禁止嵌套。 |
| Thread API | **文档已证实**：list/get/archive thread，list/stream thread events；base path `/api/v1/cloud/sessions/{session_id}/threads`。List 返回 `{data,first_id,last_id,has_more,next_page}`，Thread 含 `id,type,session_id,parent_thread_id,agent,status,stats,archived_at,created_at,updated_at`。[List Threads](https://docs.qoder.com/cloud-agents/api/sessions/threads/list) | **文档已证实**：Forward 也提供 list/get/archive Thread 及 list/stream Thread Events，base path `/api/v1/forward/sessions/...`。[Forward List Threads](https://docs.qoder.com/cloud-agents/api/forward/sessions/list-threads) | **部分运行时契约已证实**：事件/Webhook 暴露 `session_thread_id` 并支持定向中断；公开 Managed Agents API 索引未给出等价 child Thread 查询/归档 API。 | 完整 Thread facet 可先做 Qoder 两模式可选能力；百炼可先保留 child Thread 标识和定向中断，不应宣称完整 CRUD。 |
| API / 资源清理端点 | **文档已证实**：base URL `https://api.qoder.com/api/v1/cloud`。[API Overview](https://docs.qoder.com/cloud-agents/api/conventions/overview#gateway-url) 真机临时 Agent 已通过 DELETE 清理。 | **文档已证实**：base URL `https://api.qoder.com/api/v1/forward`；本轮临时 Template 与 Environment 已清理。 | **文档已证实**：`https://{workspace_id}.{region}.maas.aliyuncs.com/api/v1/agentstudio`。真机确认 Agent 清理由 `POST /agents/{id}/archive` 完成，`DELETE` 返回 405；本轮 Agent 已归档、Environment 与 Session 已删除。 | base URL 由 provider 配置和 region/workspace 派生。测试清理逻辑也必须 provider-specific。 |

本轮隔离真机已经覆盖成员版本、新 Session、嵌套/循环、百炼无环嵌套运行时、Qoder Forward 更新、百炼 child 事件、共享文件系统与并行执行。仍未覆盖的是两端同名、归档和无权成员下 reverse 的 ID→逻辑名歧义与失败策略。百炼无环嵌套已观测到不发生二级委派，但单次运行不能外推成平台在所有模型、提示词和未来版本下绝对不会递归编排。

### 隔离真机实验契约（可直接执行）

以下是根据官方 API 一手契约整理的最小实验。变量中的 ID 均应来自同一隔离测试租户/工作空间；资源名称应带唯一前缀，并在实验后归档或删除。配置请求可以证明“配置是否被接受、响应如何归一化”；事件、Agent 快照、独立 Thread ID 和重叠的工具时间戳可以分别证明本次运行的版本、线程与并行事实，但单次实验不能外推成所有条件下的调度顺序、并发上限或隐藏状态隔离保证。

#### Qoder Forward

基地址为 `https://api.qoder.com/api/v1/forward`。先创建 Environment：

```http
POST /environments
Content-Type: application/json

{"name":"oap-ma-probe-env","config":{"type":"cloud"}}
```

分别创建普通 worker Template 和 coordinator Template。`model` 必须使用 `GET /models` 返回的可用 ID；普通成员由 `template_id` 引用，Forward 在创建含普通成员的 coordinator 时会自动补 `agent_toolset_20260401`，但实验 payload 显式携带它更便于断言回显。

```http
POST /templates

{"name":"oap-ma-probe-worker","model":"<MODEL_ID>","environment_id":"<ENV_ID>","system":"Return WORKER_OK."}
```

```http
POST /templates

{"name":"oap-ma-probe-coordinator","model":"<MODEL_ID>","environment_id":"<ENV_ID>","system":"Delegate the task to the worker and report its exact result.","tools":[{"type":"agent_toolset_20260401"}],"multiagent":{"type":"coordinator","agents":[{"type":"agent","template_id":"<WORKER_TEMPLATE_ID>","name":"worker"}]}}
```

更新为新 roster、保持和清除的精确契约已经由官方文档和真机共同证实：`POST /templates/{template_id}` 是 merge update；真机确认省略 `multiagent` 保留原值、提供对象时整体替换成功、`{"multiagent":null}` 清除。GET 中成员 `name` 按调用方提交值原样回显，因此不能把它无条件当作 OpenAgentPack 逻辑键。临时 Forward Template 与 Environment 已全部清理。

创建 Forward Session 还需要 Identity；使用已有隔离 Identity，或按 Forward Identity API 创建。最小 Session payload 为：

```http
POST /sessions

{"identity_id":"<IDENTITY_ID>","template_id":"<COORDINATOR_TEMPLATE_ID>","title":"oap-ma-probe"}
```

用 Session Event API 发送要求必须委派且返回固定标记的消息后，查询线程及线程事件：

```http
GET /sessions/{session_id}/threads?limit=100
GET /sessions/{session_id}/threads/{thread_id}/events?limit=100
```

线程列表同时包含 coordinator 与 child，结构中可观测 `id`、`type`、`parent_thread_id`、`agent`、`status` 等字段；child 是否由目标 Template 产生，应以 `parent_thread_id` 和 `agent` 快照共同判断，不能仅凭响应文本猜测。Thread Event 历史不支持 Session Event 的 `types`、`order`、`include_tool_calls` 等筛选参数。[创建 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/create)；[更新 Template](https://docs.qoder.com/cloud-agents/api/forward/templates/update)；[创建 Session](https://docs.qoder.com/cloud-agents/api/forward/sessions/create)；[列出 Threads](https://docs.qoder.com/cloud-agents/api/forward/sessions/list-threads)；[列出 Thread Events](https://docs.qoder.com/cloud-agents/api/forward/sessions/list-thread-events)

#### 嵌套与循环

真机结果已经回答配置层问题：Qoder Managed 保存 `coordinator -> coordinator` 成功，保存 A↔B 直接循环也成功；Qoder Forward 保存 A↔B Template 直接循环同样成功。两种 materialization 的配置层都不能承担循环校验。Managed 成员对象使用 `{"type":"agent","id":"<AGENT_ID>"}`，Forward 使用 `{"type":"agent","template_id":"<TEMPLATE_ID>"}`，coordinator 均需 orchestration toolset。

该证据严格证明“保存层接受这些图”，不证明运行时会递归委派；Qoder 官方仍规定只有根 coordinator Thread 能创建 child。因此 OpenAgentPack 必须独立拒绝静态循环，不能把平台 API 当作循环校验器。百炼对比结果是：保存 `coordinator -> coordinator` 成功，但建立 A↔B 的第二条边返回 HTTP 400、`AGENT_010` 循环引用。

百炼无环嵌套还做了运行时真机：outer coordinator 的 roster 引用 inner coordinator，inner 的 roster 引用 worker；用户明确要求按 outer→inner→worker 执行 `echo NESTED_SUCCESS`。事件只创建一个 child Thread，`agent_name=inner`，没有为 worker 创建第二个 `sthr`；最终由 inner 自身返回执行结果。该事件证据严格证明本次运行没有二级委派，配置层接受嵌套不等于运行时递归编排。单次运行不足以断言平台绝对永远不会递归，但已经足以支持第一期禁止嵌套的产品约束，并避免不同 provider 对同一声明产生不同深度的执行图。

#### 百炼 Managed Agents

基地址为 `https://{workspace_id}.{region}.maas.aliyuncs.com/api/v1/agentstudio`。Environment 最小 payload 只要求名称；显式写 `cloud` 便于断言：

```http
POST /environments

{"name":"oap-ma-probe-env","config":{"type":"cloud"}}
```

Agent 创建最少要求 `name` 与 `model.id`。先建 worker，再建省略成员版本的 coordinator：

```http
POST /agents

{"name":"oap-ma-probe-worker","model":{"id":"<MODEL_ID>"},"system":"Return WORKER_V1."}
```

```http
POST /agents

{"name":"oap-ma-probe-coordinator","model":{"id":"<MODEL_ID>"},"system":"Always delegate to the worker and return its exact marker.","multiagent":{"type":"coordinator","agents":[{"type":"agent","id":"<WORKER_AGENT_ID>"}]}}
```

创建 Session、发送消息、拉取历史和订阅 SSE 的最小调用为：

```http
POST /sessions

{"agent":"<COORDINATOR_AGENT_ID>","environment_id":"<ENV_ID>","title":"oap-ma-probe"}

POST /sessions/{session_id}/events

{"input":[{"role":"user","type":"message","content":[{"type":"text","text":"Delegate now and return the worker marker."}]}]}

GET /sessions/{session_id}/events?limit=100
GET /sessions/{session_id}/events/stream
Accept: text/event-stream
```

百炼现在已有可观察 child Thread 的官方字段，真机事件进一步实际出现 `thread_created`、`thread_status`、`thread_message_sent`、`thread_message_received`，并为 child 返回独立 `sthr` ID。官方文档中的 Session Event `metadata` 可携带 `thread_id`，Thread 生命周期 Webhook 使用 `session.thread_created`、`session.thread_run_started`、`session.thread_idled`、`session.thread_terminated` 并在 `data.session_thread_id` 返回具体线程标识；发送 `interrupt` 可带顶层 `session_thread_id` 定向中断，工具回填也可用同字段路由到子线程。真机事件名称与 Webhook 事件名称属于不同事件面，不应强行归一成同一枚举。公开 Managed Agents API 索引仍未提供像 Qoder 那样的 Thread list/get/archive 与逐 Thread event-history 端点，因此能观察和定向控制，不等于拥有完整 Thread CRUD。[创建 Environment](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/environment/create)；[创建 Agent](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/agent/create)；[创建 Session](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/session/create)；[列出 Event](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/session/list-events)；[发送 Event](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/session/send-event)；[Webhook Thread 事件](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/callback)

#### 百炼成员版本、共享文件与并行执行真机结果

版本实验先在 worker v1 时创建 Session A但不发送消息，再把 worker 更新到 v2。Session A首次委派创建 child 时，完成结果明确回显目标 worker 的 `agent.id`、`agent.name` 和 `agent.version: 2`，从而排除“Session 创建时解析”，严格证明省略成员版本是在该 child Thread 首次创建/执行时解析最新版本。随后把 worker 更新到 v3，并在同一 Session A再次委派：平台复用同一 `sthr` ID，完成结果仍回显 `version: 2`。这严格证明已创建的 child Thread 会固定版本，不会在该 Thread 的每次调用中重新解析。对于同一 Session 中未来新建的另一个 child Thread，应按相同规则推断为在首次创建时解析，但本实验没有单独创建第二个新 Thread 验证这一外推。

共享文件实验中，worker A 写入 `/mnt/data/oap_shared_probe.txt`，worker B 成功读取精确值 `SHARED_TOKEN_7391`。这证明本次同一 Session 的不同 child 共享文件系统；它不意味着并发写同一路径具有事务隔离或确定冲突解决规则。

并行实验中，两个 child Thread 在约 130 ms 内创建且都进入 `running`。两边执行 `sleep 6` 的 shell 时间戳均为 start `1790067744`、end `1790067750`，排除了串行执行，严格证明该次运行并行。不同 `sthr` ID证明它们是独立执行线程；这支持线程/执行上下文隔离，但单次观察不能完整证明所有对话历史、内存态或隐藏运行时状态在任何条件下都不会互相泄露，也不能推出平台固定并发上限或调度公平性。

本轮全部临时 Qoder 资源已删除；百炼临时 Agent 已归档，临时 Environment 与 Session 已删除。

### Qoder

Qoder 的普通成员配置是对象引用，并且 coordinator 需要 orchestration toolset：

```json
{
  "tools": [{ "type": "agent_toolset_20260401" }],
  "multiagent": {
    "type": "coordinator",
    "agents": [
      { "type": "agent", "id": "agent_x", "version": "latest" },
      { "type": "self" },
      { "type": "advisor", "model": "ultimate" }
    ]
  }
}
```

普通成员、`self` 和 Advisor 的完整规则见 [Qoder API 配置](https://docs.qoder.com/cloud-agents/multi-agents#configure-with-the-api)。Advisor 每个 roster 最多一个，不执行工具，每次咨询使用临时 Thread，并增加模型成本和等待时间。[Qoder：Configure an Advisor](https://docs.qoder.com/cloud-agents/multi-agents#configure-an-advisor)

### 百炼

百炼同样使用对象引用，但官方本页只公布 `agent` 和 `self`：

```json
{
  "multiagent": {
    "type": "coordinator",
    "agents": [
      { "type": "self" },
      { "type": "agent", "id": "agent_researcher", "version": 3 }
    ]
  }
}
```

详见[百炼配置示例](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent#%E9%85%8D%E7%BD%AE%E7%A4%BA%E4%BE%8B)。该页没有 Advisor 或专用 orchestration toolset 的定义。

## OpenAgentPack 当前差距

仓库现状与上述官方能力不一致：

1. `packages/sdk/src/internal/providers/qoder/capabilities.ts` 和 `packages/sdk/src/internal/providers/bailian/capabilities.ts` 仍将 `multiagent` 标为 `unsupported`，理由分别是平台没有该原语；这个判断已被当前官方文档否定。
2. 公共类型 `MultiagentDecl` 只有 `{ type: "coordinator"; agents: string[] }`。它足以表达最小的“逻辑 Agent 名称 roster”，但表达不了 `self`、Qoder Advisor、成员版本策略。
3. resolver 已能把逻辑 Agent 名称解析为 provider ID，因此可复用现有 Claude/Ark 的依赖图和创建顺序。
4. Qoder create/update mapper 尚未输出 coordinator 配置，Agent 的 normalize/reverse mapper 也未保留 `multiagent`；但 mapper 已始终输出 `agent_toolset_20260401`，接入 roster 时应保留这一行为并增加回归测试。
5. 百炼 mapper 尚未处理 `multiagent`。
6. Session 事件统一类型已经保留 `session_thread_id`，但统一 `ProviderAdapter` 当前不暴露 thread list/get/archive/events/stream；这不阻塞 coordinator roster 的第一阶段支持，却限制了深度调试与单线程控制。
7. `docs/reference/providers*.md`、部署指南和 examples 的能力矩阵仍写 Qoder/百炼不支持，需要与 capability 声明同步更新。

## 建议的支持范围

推荐顺序遵循四条原则：先实现已被官方契约和真机共同证明的最小闭环；不把 provider 差异伪装成统一语义；先保证 create/read/update/clear 可逆和无损，再增加高级运行时能力；凡是会造成远端残留配置、版本漂移或 reverse 丢失的信息，都必须显式失败而不能猜测。

### 第一阶段：最小公共能力

- 保持现有公共 YAML：`multiagent: { type: coordinator, agents: [researcher, reviewer] }`。
- Qoder **Managed Agent** 与百炼将逻辑名称解析为 provider Agent ID，并映射为 `{type: "agent", id}`。若项目还会 materialize 为 Qoder **Forward Template**，必须另建映射为 `{type: "agent", template_id}`；不能复用 Managed payload。
- Qoder 沿用当前自动加入 `agent_toolset_20260401` 的行为，并增加断言，避免后续重构造成配置成功但运行时无法委派。
- 为两端启用 `multiagent: native`，补充 mapper、reverse mapper、plan/apply/diff、依赖排序和 provider conformance 测试。
- clear 语义写成 provider 契约测试：Qoder Managed 发 `multiagent: null`；百炼全量更新并使用 `agents: []`（真机读取结果为 `multiagent: null`）。
- reverse 必须通过同 workspace 资源索引把远端 ID 还原为逻辑名；找不到或不唯一时显式报错/标记 unresolved，不允许跳过成员。
- coordinator 示例必须写清任务边界、委派条件、输出格式、并行文件所有权与冲突处理。
- 公共说明可以陈述百炼真机已证实独立 child Thread、一次并行执行和同 Session 共享文件系统，但必须标注证据边界；不能宣称固定调度保证、完整上下文隔离或尚未公开的 Thread CRUD。

### 第二阶段：可选的扩展模型

在保持简单字符串 roster 向后兼容的前提下，再评估结构化成员：

```yaml
multiagent:
  type: coordinator
  agents:
    - agent: researcher
      version: latest
    - type: self
    - type: advisor
      model: ultimate
```

其中 `advisor` 是 Qoder-only；`self` 可跨 Qoder/百炼；`version` 必须明确区分“固定数字版本”“新 Session 跟随 latest”以及各 provider 省略值的不同语义。公共 schema 不应为了表面统一而抹平差异。

### 第三阶段：运行时线程能力

若产品需要“查看每个子 Agent 做了什么、只中断一个子任务、归档子线程”，再为 `ProviderAdapter` 设计可选的 Session Thread facet。Qoder 已有明确官方契约；百炼需要先从官方 API 文档确认等价端点与事件语义，不能从单个 `session_thread_id` 字段反推完整能力。

## 验收建议

- `plan` 能显示 coordinator 对成员 Agent 的依赖，`apply` 先创建成员再创建 coordinator。
- Qoder 请求体包含对象型成员引用与所需 orchestration toolset；百炼请求体包含对象型成员引用。
- 更新成员版本后，分别测试固定版本和 `latest` 的新 Session 行为；既有 Session 不应被误判为已热更新。
- 两个互不写同一文件的成员可成功被委派并汇总；Qoder 同时验证跨线程事件中带有 `session_thread_id`。
- Qoder 工具确认进入 `requires_action` 时 UI 不显示为完成，并能按 tool-use ID 恢复正确线程。
- 超过 roster 限制、引用不存在/无权访问 Agent、循环依赖等配置在 apply 前或 provider 返回时给出明确错误。

## 官方来源

- [Qoder：Multiagent orchestration](https://docs.qoder.com/cloud-agents/multi-agents)
- [阿里云百炼 Agent Studio：多智能体协作](https://docs.agent.bailian.aliyun.com/zh/managed-agents/build-agent/multiagent)

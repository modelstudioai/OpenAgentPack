# apps/webui — REST transport 开发约定

webui 是**单一 Vite SPA**,通过一条 REST transport 跑通:

| | REST transport |
|---|---|
| 形态 | 独立部署 |
| 实现 | `src/lib/api/transports/rest.ts` |
| 打到哪 | `/api/*` → `apps/server`(SDK provider)→ 公网 OpenAPI(snake_case) |

REST transport 实现接口 `ApiTransport`(`src/lib/api/contract.ts`,含权威 op 对照表),
所有调用收敛到同一份 snake_case `@openagentpack/sdk` 数据模型。事件流走 SSE
(`src/lib/api/stream.ts`)。

## 不变量:SDK 只许 type-only

`apps/webui/src/` 以下代码可 `import type @openagentpack/sdk`(类型),但禁止 runtime import
SDK 服务端/运行时代码——否则会把 SDK 打进浏览器 bundle。由 `.dependency-cruiser.cjs`
的 `no-webui-sdk-runtime-import` 强制:runtime 边在 CI 报错。

## 加一个新后端操作时

1. `server` 路由 + schema + service;若是新能力,补 SDK provider 方法。
2. `rest.ts` 方法。
3. 更新 `contract.ts` 的 op 对照表(唯一真相)。
4. 补一条用例到 `tests/` —— 校验 REST 输出形状。

两道闸门均已进 `verify:push`(跑 `check:architecture` 与 `test`)。

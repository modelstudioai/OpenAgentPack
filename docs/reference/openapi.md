# OpenAPI reference

`apps/server` is a Bun backend (built with [Hono](https://hono.dev) and `@hono/zod-openapi`) that exposes the SDK over an HTTP surface. This page documents where the OpenAPI contract comes from and how to inspect it.

## Where the contract lives

- The running server serves the OpenAPI document at `GET /openapi.json` ([`apps/server/src/app.ts`](../../apps/server/src/app.ts) registers `app.doc("/openapi.json", …)`).
- A committed snapshot is checked in at [`apps/server/openapi.json`](../../apps/server/openapi.json) so consumers can read it without running the server.
- The snapshot is regenerated with:

  ```bash
  bun run --cwd apps/server gen:openapi     # runs scripts/emit-openapi.ts
  ```

  The snapshot is required to match the running server. `apps/server/tests/openapi-contract.test.ts`
  checks both route coverage and snapshot freshness in CI.

## Registered route groups

`app.ts` mounts these route groups under `/api`:

| Group | Route file |
|-------|------------|
| Agents | `routes/agents.ts` |
| Sessions | `routes/sessions/` |
| Config | `routes/config.ts` |
| Environments | `routes/environments.ts` |
| Vaults | `routes/vaults.ts` |
| Files | `routes/files.ts` |
| Skills | `routes/skills.ts` |
| Models | `routes/models.ts` |

Routes are defined with `@hono/zod-openapi`'s `createRoute`, so request validation, typed responses,
and OpenAPI generation share the same Zod schemas. Multipart files and skill uploads use the same
route-definition seam while retaining their upload-specific validation.

## Documented endpoints

The committed `openapi.json` (`openapi: 3.0.0`, title `OpenAgentPack API`) is the complete generated
reference for every `/api/*` operation. It covers config, agents, environments, vaults, sessions,
files, skills, and models. Read that file or `GET /openapi.json` for the exact methods, paths,
parameters, and schemas; this page intentionally does not maintain a second handwritten endpoint list.

The SSE stream emits frames with event types `event`, `done`, and `ping`. A `410` response means the event buffer is no longer active — the caller should fetch the session detail once.

Errors are normalized to `{ "error": { "message": "…" } }` by the centralized error handler in `app.ts`.

## Running the server

```bash
bun install
bun run dev:server         # hot-reloading dev server
# or
bun run dev                # server + webui together
```

The server reads the same provider credentials as the CLI (`.env` and `~/.agents/config.json`); see [Provider reference](./providers.md).

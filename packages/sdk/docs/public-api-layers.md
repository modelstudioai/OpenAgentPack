# @openagentpack/sdk Public API

`@openagentpack/sdk` is the reusable OpenAgentPack runtime. Its primary package
entry is `.`, and it also exposes three deliberately narrow, browser-safe
contracts: `./session-events`, `./scan-lifecycle`, and `./file-lifecycle`.
Everything re-exported from those entries is public SDK surface; the engine
itself lives under `src/internal/` and is intentionally unreachable from
outside the package. Parser, state, provider, planner, and executor internals
must not gain subpath exports.

Interface packages such as `@openagentpack/cli` and `@openagentpack/webui` should treat the
SDK as a domain service layer, not as a bag of parser, state, provider, planner,
or executor primitives.

## Service APIs

The public entry exposes domain workflows that return structured domain results.
New CLI and WebUI behavior should start here.

- Project/resource workflows: config resolution, planning, apply, and destroy.
- Agent workflows: agent listing, readiness, resource planning, and sync.
- Session workflows: creation, runs, follow-up messages, event listing, and
  summaries.
- Deployment workflows: listing, details, and runs.
- State workflows: a file/in-memory `StateManager` plus state-address parsing.
- Validation/model workflows: config validation and provider/model discovery.

Service APIs return domain objects (sessions, plans, diagnostics, resources,
provider-neutral metadata). They do not return terminal rows, React view
models, HTTP envelopes, SSE wrappers, or localized presentation strings.

## DTO And Schema Contract

The cross-boundary data shapes live in `internal/types/dto.ts` and are
re-exported wholesale from the entry as the single source of truth — both the
TypeScript types and their Zod schemas (e.g. `SafeSessionEvent` /
`SafeSessionEventSchema`, `PlannedAction`, `AgentWithReadiness`, `Diagnostic`).
WebUI-only product models and HTTP envelopes stay in WebUI-local modules.

DTOs stay provider-neutral unless a later public DTO policy explicitly promotes
provider-specific fields.

## Internals (`src/internal/`)

These areas are engine implementation and are not exported from the package
entry. The `src/internal/` folder is a physical boundary: no `exports` map
condition resolves into it, so consumers cannot import these even by path.

- `parser/`
- `planner/`
- `providers/` — registry, adapters, clients, and mappers
- `executor/`
- `graph/`
- `state/` — backends and on-disk persistence
- `diagnostics/`, `validation/`, `session/` resolvers
- low-level deployment/session resolver details

The SDK's own service functions compose these internals; interface packages
consume the service functions instead.

## Consumer Rule

When adding a CLI or WebUI feature, ask:

1. Does an existing SDK service already perform the domain workflow?
2. If not, can a provider-neutral SDK service return the missing domain result?
3. If the desired result is presentation, transport, or product state, should it
   stay in CLI/WebUI instead?

A small number of runtime handles (`ProjectRuntimeContext`, `StateManager`,
`LocalFileStateBackend`) are deliberately exported so hosts can wire persistence
and runtime context. Beyond those, if a workflow seems to need parser outputs,
provider adapters, or planner/executor internals, treat that as a missing SDK
service rather than reaching into `src/internal/`.

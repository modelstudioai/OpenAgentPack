# SDK reference

`@openagentpack/sdk` is the Node-compatible TypeScript SDK that powers the `agents` CLI. Everything the CLI does is available programmatically. This page summarizes the public surface re-exported from `packages/sdk/src/index.ts`; the contract is detailed in [`packages/sdk/docs/public-api-layers.md`](../../packages/sdk/docs/public-api-layers.md).

## Install

```sh
npm install @openagentpack/sdk
```

## Quick example

```ts
import { resolveProjectConfig, planProjectContext } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

## API layers

The package entry is `.`. It also exposes three narrow, browser-safe subpath contracts:

- `./session-events` — session event streaming/parsing (browser-safe).
- `./scan-lifecycle` — scan lifecycle helpers.
- `./file-lifecycle` — file lifecycle helpers.

Everything re-exported from these entries is public SDK surface. The engine itself lives under `src/internal/` and is deliberately not reachable from outside the package — there is no `exports` condition that resolves into it.

## Service APIs

The public entry exposes domain workflows that return structured domain results (sessions, plans, diagnostics, resources, provider-neutral metadata). It does **not** return terminal rows, React view models, HTTP envelopes, SSE wrappers, or localized strings.

| Area | Functions |
|------|-----------|
| Project / resource workflows | `resolveProjectConfig`, `resolveProjectConfigFromObject`, `planProjectContext`, `executePlannedProject`, `decideDestructive`, `importResource`, `syncProjectResourcesWithStateBackend` |
| Validation | `validateProjectConfig`, `collectConfigReferences` |
| Sync & migrate | `resolveSyncProvider`, `syncProviderResourcesFromContext`, `syncProviderResourcesFromEnv`, `migrateConfig` |
| Destroy | `planDestroyProjectContext`, `destroyPlannedProjectResources` |
| Agent | `buildAgentDecl`, `getAgent`, `listAgentsWithReadiness`, `listCloudAgents`, `archiveCloudAgent`, `syncAgentResourcesWithStateBackend`, `createCloudEnvironment`, `deleteCloudEnvironment`, `listCloudEnvironments`, `createCloudVault`, `deleteCloudVault`, `listCloudVaults` |
| Session | `createSessionForAgent`, `startSessionRun`, `startSessionRunPolling`, `sendSessionMessageStreaming`, `sendSessionMessagePolling`, `streamSessionEvents`, `getSession`, `listSessionSummaries`, `listSessionEvents`, `deleteSession`, `isTerminalSessionStatus`, `resolveSessionProvider` |
| Files & skills | `uploadFile`, `listFiles`, `getFileInfo`, `getFileDownloadUrl`, `deleteFile`, `createSkillFromFileId`, `listSkills`, `getSkillInfo`, `deleteSkill` |
| Deployment | `listDeploymentsForContext`, `getDeploymentDetailsForContext`, `getDeploymentRuntimeProviderForContext`, `runDeploymentForContext` |
| Models | `listProviderModelsForContext`, `listProviderNames` |
| State | `StateManager`, `LocalFileStateBackend`, `parseStateAddress` |
| Runtime context | `createProjectRuntime`, `readProjectRuntime`, `writeProjectRuntime` |
| Provider config | `resolveProviderConfigFromEnv`, `applyProviderConfigToEnv`, `loadDotEnv`, `bootstrapRuntimeCredentials` (and sync variants), `resolveActiveProvider`, `AGENTS_CONFIG_PROVIDERS`, `AGENTS_PROVIDER_FIELDS` |
| Sandboxing | `prependFileHint`, `preparePromptForProvider`, `rewriteFileMentions` |

## DTO and schema contract

Cross-boundary data shapes live in `internal/types/dto.ts` and are re-exported wholesale as the single source of truth — both the TypeScript types **and** their Zod schemas (e.g. `SessionSchema`, `PlannedActionSchema`, `AgentWithReadinessSchema`, `DiagnosticSchema`). Use the schemas to validate provider/HTTP payloads at the boundary.

Notable exported types: `ResolvedProjectConfig`, `ResourceState`, `ExecutionPlan`, `PlannedAction`, `Diagnostic`, `Session`, `SessionEvent`, `CloudAgent`, `CloudEnvironment`, `CloudVault`, `ResourceType`, `ResourceAddress`, `ActionType`.

## Consumer rule

When adding a CLI or WebUI feature, ask:

1. Does an existing SDK service already perform the domain workflow?
2. If not, can a provider-neutral SDK service return the missing domain result?
3. If the desired result is presentation, transport, or product state, should it stay in the CLI/WebUI instead?

If a workflow seems to need parser outputs, provider adapters, or planner/executor internals, treat that as a missing SDK service rather than reaching into `src/internal/`.

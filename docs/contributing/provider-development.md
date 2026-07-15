# Provider development

A provider is the interchangeable execution substrate beneath the agent harness — the specific platform (Bailian, Qoder, Claude, Volcengine Ark) that runs an agent. This guide shows the six files every provider must implement and where to register it.

## Where provider code lives

Provider runtime code belongs in `packages/sdk/src/internal/providers/<name>/`. Each existing provider (`claude`, `qoder`, `bailian`, `ark`) has these six required files:

| File | Responsibility |
|------|----------------|
| `index.ts` | Side-effect entry; calls `registerProvider()`. |
| `config.ts` | Provider configuration validation (a Zod schema). |
| `capabilities.ts` | Declares the support tier for each resource kind. |
| `client.ts` | Owns provider HTTP calls. |
| `mapper.ts` | Pure mapping functions between config and provider shapes. |
| `adapter.ts` | Implements `ProviderAdapter`. |

(Bailian additionally carries an `event-mapper.ts` for session-event mapping.)

## Register the provider

Add the registration import to `packages/sdk/src/internal/providers/all.ts`:

```ts
import "./<name>/index.ts";
```

`all.ts` is a side-effect barrel — each provider's `index.ts` calls `registerProvider()` on load.

## Declare capabilities

`capabilities.ts` exports a `ProviderCapabilities` record: one entry per `ResourceKind` (`environment`, `vault`, `skill`, `agent`, `memory_store`, `mcp_server`, `multiagent`, `deployment`, `session`). Each entry is `{ tier, reason, remediation? }` where `tier` is `native`, `emulated`, or `unsupported`.

The registry validates a provider against `REQUIRED_METHODS_BY_KIND` (in `capabilities.ts`) at build time — so an unsupported kind needs no stub methods, and a supported kind must implement its lifecycle + session methods. Read/list methods are an orthogonal, à-la-carte facet and are soft-degraded at their call sites.

## Verify

```sh
bun run typecheck:sdk
bun run test:sdk
```

The canonical capability matrix in the docs is verified against these declarations by `scripts/provider-docs.test.ts` — update the matrix in [Provider reference](../reference/providers.md) (and the other canonical files listed in the test) when you add or change a tier.

## See also

- Existing providers: [`packages/sdk/src/internal/providers/claude/`](../../packages/sdk/src/internal/providers/claude/), [`qoder/`](../../packages/sdk/src/internal/providers/qoder/), [`bailian/`](../../packages/sdk/src/internal/providers/bailian/), [`ark/`](../../packages/sdk/src/internal/providers/ark/).
- [Provider reference](../reference/providers.md) for the public capability matrix.

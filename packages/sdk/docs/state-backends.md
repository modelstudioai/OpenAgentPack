# OpenAgentPack State Backends

OpenAgentPack state maps declared resource addresses to provider remote IDs and drift baselines. Core owns those state semantics, but persistence belongs to a state backend.

## Model

```text
StateScope
  tenantId
  projectId
  workspaceId?
  environmentId?
  provider?

StateBackend
  read(scope, fn)
  write(scope, fn)
```

`StateScope` is the logical ownership boundary. A host should derive it from trusted server-side context such as tenant and project identity. Browser-controlled requests should not choose filesystem state paths.

`StateBackend` supplies an `IStateManager` to a workflow. Read workflows inspect state without committing changes. Write workflows load the latest state, run the workflow, and persist the resulting state.

## Built-in Positions

| Backend | Positioning | Safety |
| --- | --- | --- |
| In-memory | Tests, examples, ephemeral runtime assembly | Single writer by default |
| Local file | Default CLI state, compatible with existing `*.state.json` files | Single writer unless configured with a lock |
| Object store | Shared state blob storage using a host-provided object adapter | Single writer or externally locked unless the adapter proves concurrent-write safety |
| Future remote service | Hosted state, RBAC, audit, backup, and stronger transactions | Backend-specific |

## Storage Dependencies

`@openagentpack/sdk` does not require a database, Redis, OSS, S3, or any object storage SDK for state backend support. Concrete backends and hosts own credentials, clients, network policy, encryption settings, and service-specific behavior.

Object-store support is intentionally an adapter boundary:

```text
ObjectStateStore
  getObject(key)
  putObject(key, body)
```

An OSS, S3, MinIO, or other object store integration can implement that boundary outside core without changing core runtime semantics.

## Safety Modes

Each backend declares one of three safety modes.

`single-writer` means overlapping writes to the same scope are not safe. This is acceptable for local CLI use and controlled single-worker automation.

`externally-locked` means the backend needs a lock or lease provider for multi-writer use. The write flow must acquire the lock before loading state and release it, or let the lease expire, after completion.

`concurrent-writer` means the backend itself prevents lost updates or state corruption for overlapping writes to the same scope. A backend should use this only when it has real compare-and-swap, transaction, or equivalent guarantees.

## Production Guidance

For a single-user CLI, local file state remains the simplest default.

For WebUI or multi-tenant hosts, derive `StateScope` from authenticated tenant/project context and route stateful workflows through a configured backend. Do not accept arbitrary state paths from browser requests.

For OSS-like object storage, treat the object store as durable blob storage and history, not as a complete state coordination system. Use an external lock backend for multi-writer deployments unless the object-store adapter can prove safe conditional writes for the exact update flow.

OpenAgentPack infrastructure state must remain infrastructure-only. Provider Sessions, WebUI tasks, event history, artifacts, and task-to-session mappings belong in host-owned product storage, not in OpenAgentPack state.

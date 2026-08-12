## Context

Environment declarations flow through the public TypeScript model and Zod parser, provider-aware validation, provider request mapping, and provider-specific reverse/normalization paths used by sync and drift detection. Qoder now exposes `config.setup_script` for both cloud and self-hosted environments, with a 64 KB UTF-8 limit, but every stage currently drops or rejects it. The same API documentation establishes POST update semantics, whole-config replacement, metadata patching, and a narrower writable package set than the shared model.

## Goals / Non-Goals

**Goals:**

- Make setup scripts converge through create, update, sync, export, and drift detection.
- Fail locally for script-size and Qoder package-manager violations.
- Normalize response-only Qoder defaults without hiding declarative differences.
- Correct update and metadata-deletion behavior without changing BYOC ownership rules.
- Prove the contract with focused automated tests and a disposable live Qoder environment.

**Non-Goals:**

- Execute setup scripts locally or expose their Session-time logs through a new API.
- Add file-path indirection for script content; the declaration remains an inline YAML string.
- Claim setup-script support for providers whose current API contract has not been verified.
- Manage externally referenced environments.

## Decisions

1. Add `setup_script?: string` to the shared environment config, but gate actual use per provider. This keeps the declaration portable while preventing adapters from silently dropping unsupported behavior. A Qoder-only extension object was considered, but would make the common Environment model needlessly provider-shaped.
2. Enforce the documented maximum with `Buffer.byteLength(value, "utf8")`, not JavaScript string length, because the remote limit is byte-oriented and scripts may contain non-ASCII content.
3. Keep the shared package union for other providers, while Qoder validation rejects non-empty `cargo`, `gem`, and `go`. Qoder normalization retains only writable `apt`, `npm`, and `pip` values and removes empty response defaults plus `packages.type`.
4. Include setup scripts in both reverse mapping and comparable normalization. Absence and an empty string remain distinct because clearing a saved script must be representable and reconciled.
5. Change Qoder environment update to POST and construct metadata tombstones from the current remote object before updating. This matches Qoder's metadata patch semantics while still sending the complete desired config.
6. Exercise live behavior with a uniquely named disposable environment loaded from `.env`, verify create/get/update/readback, then delete it in a `finally` cleanup path. No secret or `.env` content is printed.

## Risks / Trade-offs

- [Provider documentation changes again] → Keep Qoder-specific validation and normalization isolated and back it with request-contract tests.
- [A live setup script can cause Session startup failure] → Use a harmless marker script in live testing and document idempotency, failure, and secret-handling guidance.
- [Metadata tombstones could target management metadata] → Diff only non-`agents.*` remote metadata and continue injecting management metadata normally.
- [Empty arrays from Qoder cause false drift] → Canonicalize package objects on both desired and remote sides before hashing.
- [Live cleanup fails] → Print only the disposable resource ID/name and an explicit cleanup command, leaving credentials undisclosed.

## Migration Plan

The field is optional, so existing declarations retain their current hashes after normalization. Deploy the parser, validation, mapper, adapter, tests, and documentation together. Rollback is code-only; environments already containing scripts continue to exist remotely, though an older client would no longer manage that field.

## Open Questions

None. The current Qoder documentation is explicit about accepted fields, execution semantics, and update behavior.

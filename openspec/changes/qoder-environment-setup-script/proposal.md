## Why

OpenAgentPack cannot currently declare Qoder's `config.setup_script`, so environment initialization that cannot be expressed as packages is lost across create, update, sync, and drift reconciliation. The Qoder Environment adapter also diverges from the current API contract for updates and accepted package managers, making otherwise valid plans fail late or reconcile indefinitely.

## What Changes

- Add portable environment `setup_script` declarations with local UTF-8 64 KB validation.
- Support Qoder setup scripts across create, update, remote readback, sync/export, and drift comparison for cloud and self-hosted environments.
- Align Qoder Environment updates with the documented POST endpoint and full-config replacement behavior.
- Reject Qoder package-manager declarations that the API exposes only as response placeholders (`cargo`, `gem`, and `go`).
- Normalize Qoder response-only package fields and empty defaults so they do not create false drift.
- Make Qoder environment metadata deletion converge when a declared key is removed.
- Document execution semantics, failure behavior, security guidance, and examples in English and Chinese.

## Capabilities

### New Capabilities

- `environment-setup-script`: Declarative environment setup scripts, provider capability validation, lifecycle reconciliation, and user-facing execution semantics.

### Modified Capabilities

None.

## Impact

This affects the SDK environment configuration types and parser, provider validation, Qoder environment mapper and adapter, sync/drift behavior, Qoder-focused tests and fixtures, configuration documentation, environment guides, and Qoder examples. It does not introduce new runtime dependencies or change external-resource ownership semantics.

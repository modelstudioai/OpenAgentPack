## ADDED Requirements

### Requirement: Declare an environment setup script
The system SHALL accept an optional inline `config.setup_script` string for an Environment and SHALL reject scripts whose UTF-8 representation exceeds 65,536 bytes.

#### Scenario: Valid multiline script
- **WHEN** a cloud or self-hosted Environment declares a multiline setup script within the byte limit
- **THEN** configuration parsing succeeds and preserves the script exactly

#### Scenario: Oversized Unicode script
- **WHEN** an Environment setup script exceeds 65,536 UTF-8 bytes
- **THEN** validation fails locally before any provider request is made

### Requirement: Enforce provider setup-script support
The system SHALL send setup scripts only to providers that support them and SHALL report an actionable validation error for managed environments targeting an unsupported provider.

#### Scenario: Qoder managed environment
- **WHEN** a managed Qoder cloud or self-hosted Environment declares a setup script
- **THEN** the script is included in the provider Environment config

#### Scenario: Unsupported provider
- **WHEN** a managed Environment targeting another provider declares a setup script
- **THEN** validation reports that the provider does not support environment setup scripts

#### Scenario: External environment reference
- **WHEN** an externally managed Environment declaration contains a provider ID
- **THEN** OpenAgentPack does not attempt to mutate that Environment

### Requirement: Reconcile Qoder setup scripts
The system SHALL preserve Qoder setup scripts through create, update, remote readback, sync/export, and drift comparison.

#### Scenario: Script changes
- **WHEN** a declared setup script differs from the current Qoder Environment
- **THEN** planning reports an Environment update and applying it sends the complete desired config

#### Scenario: Script converges
- **WHEN** the remote Qoder Environment contains the declared setup script
- **THEN** subsequent planning reports no setup-script drift

#### Scenario: Script removal
- **WHEN** a previously configured setup script is removed from the declaration
- **THEN** the Qoder Environment is updated so future Sessions no longer execute it

### Requirement: Follow the Qoder Environment API contract
The system SHALL update Qoder Environments with the documented POST operation, SHALL converge metadata deletions, and SHALL reject writable package declarations not accepted by Qoder.

#### Scenario: Environment update
- **WHEN** an owned Qoder Environment changes
- **THEN** OpenAgentPack sends POST to the Environment resource with a complete config

#### Scenario: Metadata key removed
- **WHEN** a user metadata key previously present remotely is removed from the declaration
- **THEN** the update sends a null tombstone for that key and preserves management metadata

#### Scenario: Unsupported Qoder package manager
- **WHEN** a Qoder Environment declares a non-empty `cargo`, `gem`, or `go` package list
- **THEN** validation fails before apply with an actionable diagnostic

#### Scenario: Response defaults
- **WHEN** Qoder returns response-only package type fields, reserved package arrays, or empty writable arrays
- **THEN** normalization omits them from comparison unless they correspond to a declared writable package value

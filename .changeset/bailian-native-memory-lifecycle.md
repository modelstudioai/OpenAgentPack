---
"@openagentpack/sdk": minor
---

Add native Bailian Memory Store, memory file, and historical version APIs, including store archive, file rename, content SHA preconditions, version redaction, and opaque `page`/`next_page` pagination. Preserve native absolute paths, response fields, operation names, and service errors.

Enable declarative Bailian Memory Stores with ID-only identity, explicit import, declared-key metadata reconciliation, and recoverable initialization. Persist the created store ID and pending initializer hashes before writing content; retries resume missing pending paths without overwriting existing files. Existing and imported stores preserve runtime content by default, while explicit `entries_mode: sync` manages declared paths. Removing a store and applying, or destroying it, irreversibly archives it.

Resolve logical Memory references into native Session resources with access settings, instructions, deduplication, and an eight-store limit. Block Session mounting until initialization completes and reject Memory mounts in file-only Bailian Deployments.

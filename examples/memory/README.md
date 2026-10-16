# Memory lifecycle examples

The `memory-store` resource is declarative, while `agents memory*` commands manage
runtime content without editing `agents.yaml`.

YAML `entries` initialize new stores only by default. Applying changes to store
attributes or initialization entries does not overwrite content in an existing
store. Use `entries_mode: sync` explicitly when those paths should continue to
follow YAML; runtime-created paths remain preserved.

## Bailian IaC and Session mounting

Save this as `agents.yaml`, with the two credential variables supplied by your
environment or `.env`:

```yaml
version: "1"
providers:
  bailian:
    api_key: ${DASHSCOPE_API_KEY}
    workspace_id: ${BAILIAN_WORKSPACE_ID}
defaults:
  provider: bailian
environments:
  dev:
    config: { type: cloud }
memory_stores:
  notes:
    name: Project notes
    description: Shared project decisions
    metadata:
      team: platform
      settings: { reviewed: true }
    entries_mode: initialize
    entries:
      - key: /notes/decision.md
        content: Use a modular monolith.
agents:
  assistant:
    model: qwen-plus
    instructions: Use project memory when answering.
    environment: dev
    resources:
      - type: memory_store
        memory_store: notes
        access: read_write
        instructions: Keep durable project decisions here.
```

```bash
agents plan -f agents.yaml
agents apply -f agents.yaml
```

`notes` is the logical reference; `Project notes` is a non-unique display name.
Without a recorded remote ID, apply creates a new store. To reuse an existing
store, explicitly import its ID before apply; there is no adoption by name.
Imported and existing stores keep their contents in the default `initialize`
mode. Store-attribute updates read and merge metadata, changing only declared
keys and preserving keys added remotely.

For a new Bailian store, State records its ID and the pending initializer paths
and SHA-256 values before any file is written. A failed apply can resume against
that ID: only pending, absent paths are created, and existing files are preserved.
Keep the original pending content until initialization completes; changed or
removed pending sources are rejected. State contains hashes, not initializer
bodies. Session mounting is blocked until this initialization completes.

Set `entries_mode: sync` only when YAML should keep managing declared paths.
Sync creates or updates those files without deleting other files, including
files whose declarations were removed. Removing the whole store declaration and
applying, or destroying the project, **irreversibly archives the Bailian store**.

Session resources resolve `memory_store: notes` through State. The shorthand
`memory_stores: [notes]` mounts it read-write; an explicit resource can override
that mount's access and instructions. A Session accepts at most eight distinct
stores. Do not specify a Memory mount path; the server returns it. Bailian
Deployments accept files only and reject explicit or inherited Memory mounts.

## Bailian native Memory APIs

The SDK's runtime APIs also work with a provider-only context, without loading
YAML or changing project State:

```ts
import {
  createManagedApiContext,
  getMemoryVersion,
  listMemories,
  listMemoryVersions,
  updateMemory,
} from "@openagentpack/sdk";

const context = createManagedApiContext({
  providers: {
    bailian: {
      api_key: process.env.DASHSCOPE_API_KEY,
      workspace_id: process.env.BAILIAN_WORKSPACE_ID,
    },
  },
});
const storeId = "memstore_...";
const memoryId = "mem_...";
const firstPage = await listMemories(context.providers, "bailian", storeId, {
  path_prefix: "/notes/",
  depth: 1,
  view: "full",
  limit: 20,
});
if (firstPage.next_page) {
  const nextPage = await listMemories(context.providers, "bailian", storeId, {
    path_prefix: "/notes/",
    depth: 1,
    view: "full",
    limit: 20,
    page: firstPage.next_page,
  });
  console.log(nextPage.data);
}

await updateMemory(context.providers, "bailian", storeId, memoryId, {
  content: "Keep modules independent.",
  precondition: { type: "content_sha256", content_sha256: "<sha-from-getMemory>" },
});
const history = await listMemoryVersions(context.providers, "bailian", storeId, {
  memory_id: memoryId,
  operation: "modified",
  view: "full",
});
if (history.data[0]) {
  const version = await getMemoryVersion(context.providers, "bailian", storeId, history.data[0].id);
  console.log(version);
}
```

Bailian preserves its native response fields, including unknown service fields:

- Paths retain their leading `/`. Relative create paths are normalized to an
  absolute path. Directory listings can return a separate `prefixes` array.
- Lists return `data` and opaque `next_page`; pass that value as `page` for the
  next request. A null or missing `next_page` ends pagination; do not assume
  `has_more` or `next_cursor` is present.
- Memory updates accept an atomic path rename and an optional content SHA
  precondition. `expected_content_sha256` is also accepted and maps to the native
  `precondition` object. Conflict errors are passed through without retrying the
  write. Update responses may omit `content`; use `getMemory` to read the body.
- Version lists support `memory_id`, `operation`, `created_at.gte`,
  `created_at.lte`, `view`, `limit`, and `page`. The native operation `modified`
  is preserved. `getMemoryVersion` reads a snapshot and `redactMemoryVersion`
  redacts one; fields absent from a redacted response remain absent. Redaction
  is irreversible and does not provide a way to restore an archived store.
- `deleteMemory` returns the native `memory_deleted` receipt. Bailian does not
  support a delete SHA precondition, per-file metadata, or batch creation.
  `archiveMemoryStore` archives the container irreversibly.

## Portable lifecycle (Qoder, Claude, Ark)

```bash
agents apply -f examples/qoder/with-memory/agents.yaml
agents memory-store list -f examples/qoder/with-memory/agents.yaml --provider qoder

agents memory create <store-id> notes/decision.md \
  --content "Use a modular monolith" \
  -f examples/qoder/with-memory/agents.yaml --provider qoder

agents memory list <store-id> --full \
  -f examples/qoder/with-memory/agents.yaml --provider qoder

agents memory update <store-id> <memory-id> \
  --content "Use services after the team reaches 30 engineers" \
  --expected-sha256 <sha256-from-get> \
  -f examples/qoder/with-memory/agents.yaml --provider qoder
```

The same commands work with `--provider claude` and `--provider ark`. For these
portable adapters, use relative paths; the Claude adapter converts them to
Claude's required leading-slash form. Bailian retains native absolute paths as
described above.

## Provider-specific extensions

Qoder and Claude expose immutable version history:

```bash
agents memory version list <store-id> --memory-id <memory-id> --full -f agents.yaml --provider qoder
agents memory version redact <store-id> <version-id> -f agents.yaml --provider qoder
```

Ark exposes partial-success batch creation (`items.json` is an array of
`{"path":"...","content":"..."}` objects):

```bash
agents memory batch-create <store-id> items.json --on-conflict overwrite -f agents.yaml --provider ark
```

Ark currently uses last-write-wins and does not expose version retrieval or
redaction. Calling an unsupported extension returns a provider capability error.

## Live provider verification

The live probe creates a temporary store, exercises CRUD (plus versions or batch
creation where supported), and deletes the store in `finally`:

```bash
QODER_PAT=... bun packages/sdk/tests/e2e/memory-live.ts qoder
ANTHROPIC_API_KEY=... bun packages/sdk/tests/e2e/memory-live.ts claude
ARK_API_KEY=... bun packages/sdk/tests/e2e/memory-live.ts ark
```

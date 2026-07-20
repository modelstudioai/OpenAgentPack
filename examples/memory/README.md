# Memory lifecycle examples

The `memory-store` resource is declarative, while `agents memory*` commands manage
runtime content without editing `agents.yaml`.

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

The same commands work with `--provider claude` and `--provider ark`. Paths are
always written as portable relative paths; the Claude adapter converts them to
Claude's required leading-slash form.

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

# Contributing to OpenAgentPack CLI

Repository-wide contribution guidance now lives at the workspace root:

[CONTRIBUTING.md](../../CONTRIBUTING.md)

This package contains only the Bun terminal adapter. Provider runtime code and provider tests belong in `packages/sdk`.

## CLI Package Checks

From the repository root:

```sh
bun run typecheck:cli
bun run test:cli
```

Run `bun run typecheck` and `bun run test` from the root before submitting a repository PR.

# Development

How to set up the repo, run the CLI/WebUI from source, run verification, and respect package boundaries.

## Prerequisites

- [Bun](https://bun.sh) `1.3.5` — the pinned workspace runtime and package manager.

## Setup

```sh
git clone https://github.com/<your-github-user>/OpenAgentPack.git
cd OpenAgentPack
git remote add upstream https://github.com/modelstudioai/OpenAgentPack.git
bun install
```

Run the CLI from source without a global install:

```sh
bun run --cwd packages/cli bin/agents.ts --help
# or link it as `agents` on your PATH:
bun run link
```

Start the WebUI and its API together:

```sh
bun run dev        # server (backend) + webui (frontend)
```



## Verification

All verification entry points use the same harness (`scripts/verify.ts`). Pick the profile that matches the feedback loop:

```sh
bun run verify:scoped  # changed-file lint + affected workspace typecheck (fast feedback)
bun run verify:push    # typecheck + architecture + tests + changed-file lint
bun run verify:full    # repository gate: lint + typecheck + architecture + tests + WebUI build
bun run verify:release # full gate + package builds + npm dry-run + packed-consumer smoke
```

`verify:fast` is an alias for `verify:scoped`. CI reads the `full` profile from the harness and runs its steps in parallel.

Granular checks:

```sh
bun run lint            # biome check
bun run check:architecture   # dependency-cruiser + ast-grep semantic checks
bun run typecheck       # all workspaces
bun run test            # all workspaces
```

Per-workspace: `bun run --cwd packages/sdk typecheck` / `bun run --cwd packages/sdk test`, and likewise for `packages/cli`, `packages/playbooks`, `packages/playground`, `apps/webui`, `apps/server`.

## Package boundaries

OpenAgentPack is a Bun workspace. Packages resolve each other's TypeScript source via the `bun` export condition (`@openagentpack/sdk` and `@openagentpack/cli` also publish compiled `dist/` for non-Bun consumers). Cross-package imports must use package names such as `@openagentpack/sdk`; do not import another package's `src/**` through relative paths. Package-local tests may import their own package internals when testing internal behavior.


| Package               | npm name                    | Role                                                          |
| --------------------- | --------------------------- | ------------------------------------------------------------- |
| `packages/sdk`        | `@openagentpack/sdk`        | Runtime: providers, planning, sessions, state.                |
| `packages/cli`        | `@openagentpack/cli`        | The `agents` terminal client.                                 |
| `packages/playbooks`  | `@openagentpack/playbooks`  | Shared playbook protocol, seed catalog, and runtime resolver. |
| `packages/playground` | `@openagentpack/playground` | One-command local WebUI launcher.                             |
| `apps/webui`          | *(not published)*           | Vite single-page WebUI.                                       |
| `apps/server`         | `@openagentpack/server`     | Bun backend exposing the SDK over OpenAPI.                    |




## Code style

- TypeScript only for source and tests.
- Relative imports include `.ts` or `.tsx` extensions in Bun/core/CLI code.
- Comments should explain non-obvious intent, not restate code.
- Commits use conventional prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.



## What we do not accept

- Replacing Bun as the workspace runtime/package manager without an OpenSpec change.
- Replacing YAML config with another primary format.
- Changing the `@openagentpack/sdk` / `@openagentpack/cli` publish model (compiled `dist/` published to public npm) without a proposal.
- New runtime dependencies without justification.

See the top-level [CONTRIBUTING.md](../../CONTRIBUTING.md) for the merge requirements, and [Provider development](./provider-development.md) and [Release](./release.md) for the deeper workflows.
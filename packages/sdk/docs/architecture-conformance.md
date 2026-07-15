# Architecture Conformance

OpenAgentPack uses a tool-backed architecture gate instead of a custom workspace guard.
The gate is intentionally split in two:

- `dependency-cruiser` checks import graph boundaries.
- `ast-grep` checks project-specific semantic anti-patterns.

Run the full gate locally:

```bash
bun run check:architecture
```

Run one layer at a time:

```bash
bun run check:architecture:deps
bun run check:architecture:semantic
```

## Dependency Rules

The dependency graph rules live in `.dependency-cruiser.cjs`.

Current rules enforce:

- `packages/cli` and `apps/server` do not import each other.
- `packages/sdk` does not depend on host packages or applications.
- Non-SDK code does not deep import SDK internals.
- Browser-facing code in `apps/webui/src` does not import SDK runtime values.

The browser rule relies on post-compilation TypeScript semantics:
`import type` edges are erased and therefore allowed, while runtime imports remain
visible and fail the rule.

Negative examples:

```ts
// apps/webui/src/example.ts
import { PlannedActionSchema } from "@openagentpack/sdk"; // rejected: runtime SDK import
```

```ts
// packages/cli/src/example.ts
import { createTask } from "../../../apps/server/src/routes/tasks"; // rejected: host cross-import
```

```ts
// apps/server/src/example.ts
import { PlannedActionSchema } from "../../../packages/sdk/src/internal/types/dto"; // rejected: SDK deep import
```

## Semantic Rules

The semantic rules live in `tools/architecture/ast-grep-rules/` and are discovered
from `sgconfig.yml`.

Current rules enforce:

- SDK-owned DTO and schema names are not redefined outside `packages/sdk`.
- Host code does not make drift/apply decisions by parsing free-text
  `PlannedAction.reason` display text.

Negative examples:

```ts
// apps/webui/src/example.ts
type PlannedAction = {
	action: "create" | "update";
	reason: string;
};
```

```ts
// packages/cli/src/example.ts
if (action.reason.includes("Remote resource drifted")) {
	// rejected: use action.driftKind or another structured field instead
}
```

When adding a new SDK-owned cross-boundary DTO, update the owned-name list in the
DTO redefinition rules. Keep rules narrow and named after the architectural
contract they protect.

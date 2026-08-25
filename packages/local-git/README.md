# `@openagentpack/local-git`

Node-only local Git versioning for an OpenAgentPack `agents.yaml` project.

The package commits and restores only the selected configuration file. It never
pushes, switches branches, or reads or writes `agents.state.json`.

```ts
import { createLocalGitVersionService } from "@openagentpack/local-git";

const versions = createLocalGitVersionService({ configPath: "agents.yaml" });
const status = await versions.status();
```

The service exposes repository initialization, the shared path-scoped enable
switch, version history and redacted previews, prepared Apply commits, and
atomic working-tree restore. `initialize()` creates `main` when needed but does
not create a baseline commit or enable automatic versions; the host chooses
that policy explicitly with `enable()`.

## License

Apache-2.0. See the repository license.

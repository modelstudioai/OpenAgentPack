# `@openagentpack/project-versions`

Git-independent, Node-only local version primitives for OpenAgentPack.

`createDirectoryProjectVersionService` stores full directory manifests, file modes,
text, and binary content in immutable entries and content-addressed blobs. A host
adapter supplies validation and atomic restore; `@openagentpack/project-workspace`
provides the standard directory-project adapter and excludes generated Build,
locks, versions, and remote State from source snapshots.

```ts
import { createDirectoryWorkspaceVersionService } from "@openagentpack/project-workspace";

const versions = createDirectoryWorkspaceVersionService("./my-agent");
await versions.enable();
```

The existing `createProjectVersionService` YAML service remains exported for
compatibility, but project CLI and Workbench use the directory service.

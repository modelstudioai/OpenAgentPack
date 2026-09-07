# `@openagentpack/sdk/project-versions`

Git-independent, Node-only local version primitives included in `@openagentpack/sdk`.
Existing `.openagentpack/versions` data, snapshot IDs, locks, and source formats
remain compatible with the earlier standalone implementation. No data migration
or reinitialization is required.

`createDirectoryProjectVersionService` stores full directory manifests, file modes,
text, and binary content in immutable entries and content-addressed blobs. A host
adapter supplies validation and atomic restore; `@openagentpack/sdk/project-workspace`
provides the standard directory-project adapter and excludes generated Build,
locks, versions, and remote State from source snapshots.

```ts
import { createDirectoryWorkspaceVersionService } from "@openagentpack/sdk/project-workspace";

const versions = createDirectoryWorkspaceVersionService("./my-agent");
await versions.enable();
```

The existing `createProjectVersionService` YAML service remains exported for
compatibility, but project CLI and Workbench use the directory service.

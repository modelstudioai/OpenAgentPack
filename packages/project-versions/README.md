# `@openagentpack/project-versions`

Git-independent, Node-only local versions for an OpenAgentPack `agents.yaml` project.

The service stores its switch and head pointer in `.openagentpack/versions/store.json`, immutable metadata
in `entries/<version-id>.json`, and complete content-addressed YAML in `blobs/<sha256>.yaml`.
`agents.state.json` and referenced files are never included.

```ts
import { createProjectVersionService } from "@openagentpack/project-versions";

const versions = createProjectVersionService({ configPath: "agents.yaml" });
await versions.enable();
```

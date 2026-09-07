# `@openagentpack/sdk`

The Node-compatible TypeScript SDK that powers [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack).

## Install

```sh
npm install @openagentpack/sdk
```

## Example

```ts
import { planProjectContext, resolveProjectConfig } from "@openagentpack/sdk";

const config = await resolveProjectConfig({ configPath: "agents.yaml" });
const plan = await planProjectContext(config);
console.log(plan);
```

## Local projects and versions

The same SDK package includes Node.js subpaths for directory projects and local
snapshots; no additional OpenAgentPack packages are required:

```ts
import { initializeDirectoryProject } from "@openagentpack/sdk/project-workspace";
import { createDirectoryProjectVersionService } from "@openagentpack/sdk/project-versions";
```

Use [project-workspace](https://github.com/modelstudioai/OpenAgentPack/blob/main/packages/sdk/docs/project-workspace.md)
for Init, Build, Publish, and validated directory restore. The lower-level
[project-versions](https://github.com/modelstudioai/OpenAgentPack/blob/main/packages/sdk/docs/project-versions.md)
subpath exposes snapshot storage primitives. Existing local snapshots remain
compatible without migration. These services are not re-exported from the SDK's
default entry point.

See the [configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md), [provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md), and [SDK documentation](https://github.com/modelstudioai/OpenAgentPack/tree/main/packages/sdk/docs).

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

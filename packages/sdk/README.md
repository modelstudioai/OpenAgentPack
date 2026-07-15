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

See the [configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md), [provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md), and [SDK documentation](https://github.com/modelstudioai/OpenAgentPack/tree/main/packages/sdk/docs).

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

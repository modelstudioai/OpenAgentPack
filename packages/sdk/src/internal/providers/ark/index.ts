import { registerProvider } from "../registry.ts";
import { ArkAdapter } from "./adapter.ts";
import { ARK_CAPABILITIES } from "./capabilities.ts";
import { type ArkConfig, arkConfigSchema } from "./config.ts";

registerProvider({
	name: "ark",
	configSchema: arkConfigSchema,
	capabilities: ARK_CAPABILITIES,
	createAdapter: (config, projectName) => {
		const c = config as ArkConfig;
		return new ArkAdapter(c.api_key, projectName);
	},
});

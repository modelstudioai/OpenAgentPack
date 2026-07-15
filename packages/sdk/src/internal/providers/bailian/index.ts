import { registerProvider } from "../registry.ts";
import { BailianAdapter } from "./adapter.ts";
import { BAILIAN_CAPABILITIES } from "./capabilities.ts";
import { type BailianConfig, bailianConfigSchema } from "./config.ts";

registerProvider({
	name: "bailian",
	configSchema: bailianConfigSchema,
	capabilities: BAILIAN_CAPABILITIES,
	createAdapter: (config, projectName) => {
		const c = config as BailianConfig;
		return new BailianAdapter(c.api_key, c.workspace_id, c.base_url, projectName);
	},
});

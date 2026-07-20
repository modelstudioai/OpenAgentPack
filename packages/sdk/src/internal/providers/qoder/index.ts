import { registerProvider } from "../registry.ts";
import { QoderAdapter } from "./adapter.ts";
import { QODER_CAPABILITIES } from "./capabilities.ts";
import { type QoderConfig, qoderConfigSchema } from "./config.ts";

registerProvider({
	name: "qoder",
	configSchema: qoderConfigSchema,
	capabilities: QODER_CAPABILITIES,
	createAdapter: (config, projectName) => {
		const c = config as QoderConfig;
		return new QoderAdapter(c.api_key, c.gateway, projectName, c.forward_gateway);
	},
});

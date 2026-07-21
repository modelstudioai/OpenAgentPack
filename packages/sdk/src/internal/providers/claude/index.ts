import { registerProvider } from "../registry.ts";
import { ClaudeAdapter } from "./adapter.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { type ClaudeConfig, claudeConfigSchema } from "./config.ts";

registerProvider({
	name: "claude",
	configSchema: claudeConfigSchema,
	capabilities: CLAUDE_CAPABILITIES,
	features: { tool_permissions: true, session_resources: ["github_repository"] },
	createAdapter: (config, projectName) => {
		const c = config as ClaudeConfig;
		return new ClaudeAdapter(c.api_key, c.beta, projectName);
	},
});

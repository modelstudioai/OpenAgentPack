import type { ProviderCapabilities } from "../capabilities.ts";

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "cloud environments API" },
	vault: { tier: "native", reason: "vaults API" },
	skill: { tier: "native", reason: "skills API with files[] upload" },
	agent: { tier: "native", reason: "managed agents API" },
	memory_store: {
		tier: "unsupported",
		reason: "no memory store primitive on Claude",
		remediation: "use skill knowledge or MCP for context persistence",
	},
	mcp_server: { tier: "native", reason: "mcp_servers field on agent" },
	multiagent: { tier: "native", reason: "coordinator + roster topology" },
	deployment: { tier: "native", reason: "deployments API" },
	session: { tier: "native", reason: "sessions API" },
};

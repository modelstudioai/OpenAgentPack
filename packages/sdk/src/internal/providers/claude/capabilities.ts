import type { ProviderCapabilities } from "../capabilities.ts";

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "cloud environments API" },
	vault: { tier: "native", reason: "vaults API" },
	skill: { tier: "native", reason: "skills API with files[] upload" },
	agent: { tier: "native", reason: "managed agents API" },
	memory_store: {
		tier: "unsupported",
		reason: "Claude exposes Memory Stores, but the OpenAgentPack adapter has not implemented them yet",
		remediation: "use skill knowledge or MCP until Claude Memory Store support is added to the adapter",
	},
	mcp_server: { tier: "native", reason: "mcp_servers field on agent" },
	multiagent: { tier: "native", reason: "coordinator + roster topology" },
	deployment: { tier: "native", reason: "deployments API" },
	session: { tier: "native", reason: "sessions API" },
};

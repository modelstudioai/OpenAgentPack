import type { ProviderCapabilities } from "../capabilities.ts";

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "cloud environments API" },
	vault: { tier: "native", reason: "vaults API" },
	skill: { tier: "native", reason: "skills API with files[] upload" },
	agent: { tier: "native", reason: "managed agents API" },
	template: { tier: "unsupported", reason: "no Forward Template equivalent on Claude" },
	memory_store: { tier: "native", reason: "beta memory_stores API" },
	mcp_server: { tier: "native", reason: "mcp_servers field on agent" },
	multiagent: { tier: "native", reason: "coordinator + roster topology" },
	deployment: { tier: "native", reason: "deployments API" },
	session: { tier: "native", reason: "sessions API" },
	identity: { tier: "unsupported", reason: "no mapped Identity primitive on Claude" },
	channel: { tier: "unsupported", reason: "no mapped messaging Channel primitive on Claude" },
};

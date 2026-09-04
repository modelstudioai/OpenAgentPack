import type { ProviderCapabilities } from "../capabilities.ts";

export const BAILIAN_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "environments API" },
	vault: { tier: "native", reason: "vaults + environment_variable credentials API" },
	skill: { tier: "native", reason: "skills API with 2-step zip upload via Files API" },
	agent: { tier: "native", reason: "agents API with versioned updates" },
	template: { tier: "unsupported", reason: "no Forward Template equivalent on Bailian" },
	memory_store: {
		tier: "unsupported",
		reason: "no memory store primitive on Bailian",
	},
	mcp_server: { tier: "native", reason: "mcp_servers field on agent (official servers)" },
	multiagent: {
		tier: "unsupported",
		reason: "no multiagent primitive on Bailian",
		remediation: "deploy agents independently and orchestrate via MCP",
	},
	deployment: {
		tier: "native",
		reason: "deployments API with cron schedules, manual runs, pause/unpause and archive",
	},
	session: { tier: "native", reason: "sessions API" },
	identity: { tier: "unsupported", reason: "no mapped Identity primitive on Bailian" },
	channel: { tier: "unsupported", reason: "no mapped messaging Channel primitive on Bailian" },
};

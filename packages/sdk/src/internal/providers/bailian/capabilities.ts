import type { ProviderCapabilities } from "../capabilities.ts";

export const BAILIAN_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "environments API" },
	vault: { tier: "native", reason: "vaults + credentials API (static_bearer MCP credentials)" },
	skill: { tier: "native", reason: "skills API with 2-step zip upload via Files API" },
	agent: { tier: "native", reason: "agents API with versioned updates" },
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
		tier: "emulated",
		reason: "no deployment primitive on Bailian; expanded into a session at run time",
		remediation:
			"scheduling and outcome rubrics are not enforced server-side — use external cron/CI for always-on or scheduled runs",
	},
	session: { tier: "native", reason: "sessions API" },
};

import type { ProviderCapabilities } from "../capabilities.ts";

export const QODER_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "environments API" },
	vault: { tier: "native", reason: "vaults + MCP credentials" },
	skill: { tier: "native", reason: "skills API with zip upload" },
	agent: { tier: "native", reason: "agents API" },
	memory_store: { tier: "native", reason: "memory_stores API" },
	mcp_server: { tier: "native", reason: "mcp_servers field on agent" },
	multiagent: {
		tier: "unsupported",
		reason: "no multiagent primitive on Qoder",
		remediation: "deploy agents independently and orchestrate via MCP",
	},
	deployment: {
		tier: "emulated",
		reason: "no deployment primitive on Qoder; expanded into a session at run time",
		remediation:
			"scheduling and outcome rubrics are not enforced server-side — use external cron/CI for always-on or scheduled runs",
	},
	session: { tier: "native", reason: "sessions API" },
};

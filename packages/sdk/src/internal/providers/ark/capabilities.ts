import type { ProviderCapabilities } from "../capabilities.ts";

export const ARK_CAPABILITIES: ProviderCapabilities = {
	environment: { tier: "native", reason: "cloud environments API" },
	vault: { tier: "native", reason: "vaults API" },
	skill: { tier: "native", reason: "skills API with single-zip upload (create + get + attach only)" },
	agent: { tier: "native", reason: "managed agents API" },
	template: { tier: "unsupported", reason: "no Forward Template equivalent on Ark" },
	memory_store: { tier: "native", reason: "memory_stores API" },
	mcp_server: { tier: "native", reason: "mcp_servers field on agent" },
	multiagent: { tier: "native", reason: "coordinator + roster topology" },
	deployment: {
		tier: "emulated",
		reason: "no deployment primitive on Ark; expanded into a session at run time",
	},
	session: { tier: "native", reason: "sessions API" },
	identity: { tier: "unsupported", reason: "no mapped Identity primitive on Ark" },
	channel: { tier: "unsupported", reason: "no mapped messaging Channel primitive on Ark" },
};

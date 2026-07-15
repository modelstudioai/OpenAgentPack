import type { ProjectConfig } from "../types/config.ts";

export interface MissingBailianMcpToolConfig {
	agentName: string;
	serverName: string;
}

export function findMissingBailianMcpToolConfigs(
	config: ProjectConfig,
	providerName = "bailian",
): MissingBailianMcpToolConfig[] {
	if (providerName !== "bailian") return [];

	const missing: MissingBailianMcpToolConfig[] = [];
	for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
		if (!agentTargetsProvider(config, agent.provider, providerName)) continue;

		const configuredToolServers = new Set((agent.tools?.mcp ?? []).map((tool) => tool.mcp_server_name));

		for (const server of agent.mcp_servers ?? []) {
			if (!configuredToolServers.has(server.name)) {
				missing.push({ agentName, serverName: server.name });
			}
		}
	}

	return missing;
}

function agentTargetsProvider(config: ProjectConfig, agentProvider: string | undefined, providerName: string): boolean {
	if (agentProvider) return agentProvider === providerName;

	const defaultProvider = config.defaults?.provider;
	if (defaultProvider && defaultProvider !== "all") {
		return defaultProvider === providerName;
	}

	return Object.hasOwn(config.providers, providerName);
}

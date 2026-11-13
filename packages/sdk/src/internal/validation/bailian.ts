import type { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import type { ProjectConfig } from "../types/config.ts";
import { resolveBuiltinTools } from "../utils/tool-permissions.ts";

/** Bailian enforces approvals only on the main Agent, including when Self is delegated. */
export function collectBailianSubagentToolPermissionDiagnostics(
	config: ProjectConfig,
	providerName: string,
	diagnostics: DiagnosticCollector,
): void {
	if (providerName !== "bailian") return;
	for (const [name, coordinator] of Object.entries(config.agents ?? {})) {
		if (coordinator.provider && coordinator.provider !== providerName) continue;
		for (const member of coordinator.multiagent?.agents ?? []) {
			// External ids carry no local tool declaration; never infer their policies.
			if (typeof member !== "string" && !("type" in member)) continue;
			const memberName = typeof member === "string" ? member : name;
			const agent = config.agents?.[memberName];
			if (!agent?.tools || (agent.provider && agent.provider !== providerName)) continue;
			const approvalTools = resolveBuiltinTools(agent.tools)
				.filter((tool) => tool.permission === "ask")
				.map((tool) => tool.configuredName);
			if (!approvalTools.length) continue;
			diagnostics.error(
				"bailian.agent.multiagent.tool_permissions.unsupported",
				`agent.${name}: member '${memberName}'${typeof member === "string" ? "" : " (Self)"} requires approval for ${approvalTools.join(", ")}, but Bailian supports tool approval only on the main Agent. Run this member as a main Agent or remove its effective 'ask' policies before delegating. / 百炼子 Agent 不支持工具审批，请独立运行该成员或移除其有效 ask 策略。`,
				{ type: "agent", name, provider: providerName },
			);
		}
	}
}

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

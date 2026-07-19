// 配置校验单一管线:把"引用完整性"与"provider 能力匹配"统一成 Diagnostic[]。
// CLI(validate/plan/apply)与 planner 共用同一套检查,消除 string[]/Diagnostic[] 双轨与 Bailian-MCP 重复。
// 副作用导入 providers/all:离线 validate 也需 registry 已注册(与 core runtime 模块同款)。
import "../providers/all.ts";

import { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import { isSupported } from "../providers/capabilities.ts";
import { getProvider } from "../providers/registry.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { Diagnostic } from "../types/plan.ts";
import type { ResourceAddress } from "../types/state.ts";
import { findMissingBailianMcpToolConfigs } from "../validation/bailian.ts";

export interface ValidateProjectConfigOptions {
	/** Providers to capability-check. Defaults to the config's target providers. */
	providers?: string[];
}

/** Full config validation: cross-references + provider capabilities. Used by `agents validate`/plan/apply. */
export function validateProjectConfig(config: ProjectConfig, options: ValidateProjectConfigOptions = {}): Diagnostic[] {
	const collector = new DiagnosticCollector();
	collectReferenceDiagnostics(config, collector);
	const providers = options.providers ?? resolveTargetProviders(config);
	collectProviderCapabilities(config, providers, collector);
	return collector.getAll();
}

/**
 * Reference checks only (no provider capabilities). The low-level primitive for hosts
 * that must NOT run provider capability rules — e.g. webui playbooks use server-only MCP
 * (no tools.mcp), which the Bailian capability check would wrongly flag.
 */
export function collectConfigReferences(config: ProjectConfig): Diagnostic[] {
	const collector = new DiagnosticCollector();
	collectReferenceDiagnostics(config, collector);
	return collector.getAll();
}

export function resolveTargetProviders(config: ProjectConfig): string[] {
	const defaultProvider = config.defaults?.provider;
	if (!defaultProvider || defaultProvider === "all") {
		return Object.keys(config.providers);
	}
	return [defaultProvider];
}

export function collectReferenceDiagnostics(config: ProjectConfig, diagnostics: DiagnosticCollector): void {
	const envNames = new Set(Object.keys(config.environments ?? {}));
	const tunnelNames = new Set(Object.keys(config.tunnels ?? {}));
	const skillNames = new Set(Object.keys(config.skills ?? {}));
	const vaultNames = new Set(Object.keys(config.vaults ?? {}));
	const memoryNames = new Set(Object.keys(config.memory_stores ?? {}));
	const agentNames = new Set(Object.keys(config.agents ?? {}));

	for (const [name, agent] of Object.entries(config.agents ?? {})) {
		if (agent.environment && !envNames.has(agent.environment)) {
			diagnostics.error(
				"config.agent.environment.unknown",
				`agent.${name}: references unknown environment '${agent.environment}'`,
			);
		}
		if (agent.tunnel && !tunnelNames.has(agent.tunnel)) {
			diagnostics.error("config.agent.tunnel.unknown", `agent.${name}: references unknown tunnel '${agent.tunnel}'`);
		}
		for (const skill of agent.skills ?? []) {
			if (typeof skill !== "string") continue;
			if (!skillNames.has(skill)) {
				diagnostics.error("config.agent.skill.unknown", `agent.${name}: references unknown skill '${skill}'`);
			}
		}
		if (agent.vault && !vaultNames.has(agent.vault)) {
			diagnostics.error("config.agent.vault.unknown", `agent.${name}: references unknown vault '${agent.vault}'`);
		}
		for (const memory of agent.memory_stores ?? []) {
			if (!memoryNames.has(memory)) {
				diagnostics.error(
					"config.agent.memory_store.unknown",
					`agent.${name}: references unknown memory_store '${memory}'`,
				);
			}
		}
		if (agent.multiagent) {
			for (const subAgent of agent.multiagent.agents) {
				if (!agentNames.has(subAgent)) {
					diagnostics.error(
						"config.agent.multiagent.unknown",
						`agent.${name}: multiagent references unknown agent '${subAgent}'`,
					);
				}
				if (subAgent === name) {
					diagnostics.error("config.agent.multiagent.self", `agent.${name}: multiagent cannot reference itself`);
				}
			}
		}
	}

	for (const [name, deployment] of Object.entries(config.deployments ?? {})) {
		if (deployment.tunnel && !tunnelNames.has(deployment.tunnel)) {
			diagnostics.error(
				"config.deployment.tunnel.unknown",
				`deployment.${name}: references unknown tunnel '${deployment.tunnel}'`,
			);
		}
	}
}

export function collectProviderCapabilities(
	config: ProjectConfig,
	providers: string[],
	diagnostics: DiagnosticCollector,
): void {
	for (const providerName of providers) {
		const def = getProvider(providerName);
		if (!def) {
			diagnostics.error(
				"provider.unknown",
				`Provider '${providerName}' is not registered. Available: check provider imports.`,
			);
			continue;
		}
		const caps = def.capabilities;

		if (providerName === "qoder") {
			// Qoder's /deployments API rejects tunnel_id (HTTP 400 "unknown field"), so
			// a declared/inherited tunnel is dropped from the deployment payload and
			// server-side runs execute without it. Surface that degradation loudly.
			for (const [name, deployment] of Object.entries(config.deployments ?? {})) {
				if (deployment.provider && deployment.provider !== providerName) continue;
				const tunnel = deployment.tunnel ?? config.agents?.[deployment.agent]?.tunnel;
				if (tunnel) {
					diagnostics.warning(
						`${providerName}.deployment.tunnel.unsupported`,
						`deployment.${name}: Qoder's deployment API does not accept tunnel_id; scheduled and triggered runs ` +
							`execute in the deployment's environment but without the BYOC tunnel. Create sessions directly for private-network MCP access.`,
						{ type: "deployment", name, provider: providerName },
					);
				}
			}
		}

		if (providerName !== "qoder") {
			for (const [name, env] of Object.entries(config.environments ?? {})) {
				// External references are never sent to the provider API, so a
				// self_hosted type on them is inert; only managed environments matter.
				if (env.environment_id) continue;
				if (env.config.type === "self_hosted" && (!env.provider || env.provider === providerName)) {
					diagnostics.error(
						`${providerName}.environment.self_hosted.unsupported`,
						`environment.${name}: self_hosted environments are supported only by Qoder BYOC; ` +
							`use type 'cloud' or pin this environment to the qoder provider.`,
						{ type: "environment", name, provider: providerName },
					);
				}
			}
			for (const [name, agent] of Object.entries(config.agents ?? {})) {
				if (agent.tunnel && (!agent.provider || agent.provider === providerName)) {
					diagnostics.error(
						`${providerName}.agent.tunnel.unsupported`,
						"Tunnels are supported only by Qoder BYOC sessions.",
						{ type: "agent", name, provider: providerName },
					);
				}
			}
			for (const [name, deployment] of Object.entries(config.deployments ?? {})) {
				if (deployment.tunnel && (!deployment.provider || deployment.provider === providerName)) {
					diagnostics.error(
						`${providerName}.deployment.tunnel.unsupported`,
						"Tunnels are supported only by Qoder BYOC sessions.",
						{ type: "deployment", name, provider: providerName },
					);
				}
			}
		}

		for (const missing of findMissingBailianMcpToolConfigs(config, providerName)) {
			diagnostics.error(
				`${providerName}.agent.mcp_toolkit_missing`,
				`Bailian MCP server '${missing.serverName}' requires a matching tools.mcp entry.`,
				{ type: "agent", name: missing.agentName, provider: providerName },
			);
		}

		if (config.memory_stores && !isSupported(caps, "memory_store")) {
			for (const [name, decl] of Object.entries(config.memory_stores)) {
				if (!decl.provider || decl.provider === providerName) {
					diagnostics.error(
						`${providerName}.memory_store.unsupported`,
						`${caps.memory_store.reason}. ${caps.memory_store.remediation ?? ""}`.trim(),
						{ type: "memory_store", name, provider: providerName },
					);
				}
			}
		}

		if (config.agents && !isSupported(caps, "multiagent")) {
			for (const [name, agent] of Object.entries(config.agents)) {
				if (agent.multiagent) {
					if (!agent.provider || agent.provider === providerName) {
						diagnostics.error(
							`${providerName}.multiagent.unsupported`,
							`${caps.multiagent.reason}. ${caps.multiagent.remediation ?? ""}`.trim(),
							{ type: "agent", name, provider: providerName },
						);
					}
				}
			}
		}

		if (config.deployments && caps.deployment.tier === "emulated") {
			for (const [name, dep] of Object.entries(config.deployments)) {
				if (dep.provider && dep.provider !== providerName) continue;
				const addr: ResourceAddress = { type: "deployment", name, provider: providerName };

				if (dep.schedule) {
					diagnostics.warning(
						`${providerName}.deployment.schedule_unsupported`,
						"Schedules are not enforced server-side on this provider; trigger runs via external cron/CI.",
						addr,
					);
				}

				if (dep.initial_events?.some((e) => e.type === "user.define_outcome")) {
					diagnostics.warning(
						`${providerName}.deployment.define_outcome_unsupported`,
						"Outcome rubrics (user.define_outcome) are not enforced server-side on this provider; the run executes without rubric grading.",
						addr,
					);
				}

				if (dep.resources?.some((r) => r.type === "github_repository")) {
					diagnostics.warning(
						`${providerName}.deployment.github_repository_unsupported`,
						"github_repository resources are not provisioned on this provider; clone the repository inside the session instead.",
						addr,
					);
				}

				if (dep.resources?.some((r) => r.type === "memory_store" && (r.access === "read_only" || r.instructions))) {
					diagnostics.warning(
						`${providerName}.deployment.memory_store_options_unsupported`,
						"Per-resource memory_store access/instructions are not honored on this provider; the store is attached with default access.",
						addr,
					);
				}
			}
		}
	}
}

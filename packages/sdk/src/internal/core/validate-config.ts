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
import { providerMountPrefix } from "../utils/sandbox-mount.ts";
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
	const identityNames = new Set(Object.keys(config.identities ?? {}));

	if (config.defaults?.identity && !identityNames.has(config.defaults.identity)) {
		diagnostics.error(
			"config.defaults.identity.unknown",
			`defaults.identity references unknown identity '${config.defaults.identity}'`,
		);
	}

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

	for (const [name, channel] of Object.entries(config.channels ?? {})) {
		if (!agentNames.has(channel.agent)) {
			diagnostics.error("config.channel.agent.unknown", `channel.${name}: references unknown agent '${channel.agent}'`);
		}
		const identity = channel.identity ?? config.defaults?.identity;
		if (!identity) {
			diagnostics.error(
				"config.channel.identity.required",
				`channel.${name}: declare identity or configure defaults.identity`,
			);
		} else if (!identityNames.has(identity)) {
			diagnostics.error(
				"config.channel.identity.unknown",
				`channel.${name}: references unknown identity '${identity}'`,
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

		for (const [name, identity] of Object.entries(config.identities ?? {})) {
			if (identity.provider && identity.provider !== providerName) continue;
			if (!isSupported(caps, "identity")) {
				diagnostics.error(
					`${providerName}.identity.unsupported`,
					`${caps.identity.reason}. ${caps.identity.remediation ?? ""}`.trim(),
					{ type: "identity", name, provider: providerName },
				);
			}
		}

		for (const [name, channel] of Object.entries(config.channels ?? {})) {
			if (channel.provider && channel.provider !== providerName) continue;
			if (!isSupported(caps, "channel")) {
				diagnostics.error(
					`${providerName}.channel.unsupported`,
					`${caps.channel.reason}. ${caps.channel.remediation ?? ""}`.trim(),
					{ type: "channel", name, provider: providerName },
				);
				continue;
			}

			if (providerName === "qoder") {
				const agent = config.agents?.[channel.agent];
				if (agent?.provider && agent.provider !== providerName) {
					diagnostics.error(
						"config.channel.agent.provider_mismatch",
						`channel.${name}: agent '${channel.agent}' is pinned to provider '${agent.provider}'.`,
						{ type: "channel", name, provider: providerName },
					);
				}
				const identityName = channel.identity ?? config.defaults?.identity;
				const identity = identityName ? config.identities?.[identityName] : undefined;
				if (identity?.provider && identity.provider !== providerName) {
					diagnostics.error(
						"config.channel.identity.provider_mismatch",
						`channel.${name}: identity '${identityName}' is pinned to provider '${identity.provider}'.`,
						{ type: "channel", name, provider: providerName },
					);
				}
				if (agent && agent.delivery?.qoder?.type !== "forward") {
					diagnostics.error(
						"qoder.channel.forward_template.required",
						`channel.${name}: Qoder Channels require agent '${channel.agent}' to use delivery.qoder.type: forward.`,
						{ type: "channel", name, provider: providerName },
					);
				}
				const requiredCredentials: Record<string, string[]> = {
					dingtalk: ["client_id", "client_secret"],
					feishu: ["app_id", "app_secret"],
					wecom: ["bot_id", "secret"],
				};
				if (channel.type === "wechat") {
					diagnostics.error(
						"qoder.channel.wechat.credentials.unsupported",
						`channel.${name}: personal WeChat supports QR binding only; credential-based apply is unavailable.`,
						{ type: "channel", name, provider: providerName },
					);
				} else if (!requiredCredentials[channel.type]) {
					diagnostics.error(
						"qoder.channel.type.unsupported",
						`channel.${name}: unsupported Qoder channel type '${channel.type}'.`,
						{ type: "channel", name, provider: providerName },
					);
				} else {
					const missing = requiredCredentials[channel.type]!.filter((key) => !channel.credentials?.[key]);
					if (missing.length) {
						diagnostics.error(
							"qoder.channel.credentials.required",
							`channel.${name}: '${channel.type}' requires credentials: ${missing.join(", ")}.`,
							{ type: "channel", name, provider: providerName },
						);
					}
				}
			}
		}

		for (const [name, agent] of Object.entries(config.agents ?? {})) {
			if (agent.provider && agent.provider !== providerName) continue;
			const delivery = agent.delivery?.[providerName]?.type ?? "managed";
			const address: ResourceAddress = {
				type: delivery === "forward" ? "template" : "agent",
				name,
				provider: providerName,
			};
			const asksForApproval =
				agent.tools?.default_permission === "ask" ||
				Object.values(agent.tools?.permissions ?? {}).some((permission) => permission === "ask");
			if (asksForApproval && !def.features.tool_permissions) {
				diagnostics.error(
					`${providerName}.agent.tool_permissions.unsupported`,
					`agent.${name}: provider '${providerName}' cannot enforce interactive tool permission 'ask'.`,
					address,
				);
			}
			for (const resource of agent.resources ?? []) {
				if (!def.features.session_resources.includes(resource.type)) {
					diagnostics.error(
						`${providerName}.agent.session_resource.${resource.type}.unsupported`,
						`agent.${name}: provider '${providerName}' does not support Session resource type '${resource.type}'.`,
						address,
					);
				}
				const mountPrefix = providerMountPrefix(providerName);
				if (
					mountPrefix &&
					resource.mount_path &&
					resource.mount_path !== mountPrefix &&
					!resource.mount_path.startsWith(`${mountPrefix}/`)
				) {
					diagnostics.error(
						`${providerName}.agent.session_resource.mount_path.invalid`,
						`agent.${name}: ${providerName} Session resource mount_path must start with '${mountPrefix}/'.`,
						address,
					);
				}
			}
			if (delivery === "forward" && agent.resources?.length) {
				diagnostics.error(
					`${providerName}.template.session_resources.unsupported`,
					`agent.${name}: Forward delivery cannot attach Agent Session resources; use managed delivery.`,
					address,
				);
			}
			if (delivery === "forward" && !isSupported(caps, "template")) {
				diagnostics.error(
					`${providerName}.agent.delivery.forward.unsupported`,
					`agent.${name}: provider '${providerName}' does not support delivery type 'forward'. Supported delivery types: managed.`,
					{ type: "agent", name, provider: providerName },
				);
			}
			if (delivery === "forward" && providerName === "qoder") {
				if (!agent.environment) {
					diagnostics.error(
						"qoder.template.environment.required",
						`agent.${name}: Qoder Forward delivery requires an environment.`,
						{ type: "template", name, provider: providerName },
					);
				}
				if (agent.memory_stores?.length) {
					diagnostics.error(
						"qoder.template.memory_store.unsupported",
						`agent.${name}: memory_stores are not yet supported by Qoder Forward Template delivery.`,
						{ type: "template", name, provider: providerName },
					);
				}
				if (agent.multiagent) {
					diagnostics.error(
						"qoder.template.multiagent.unsupported",
						`agent.${name}: multiagent is not yet supported by Qoder Forward Template delivery.`,
						{ type: "template", name, provider: providerName },
					);
				}
			}
		}

		if (providerName === "qoder") {
			// Qoder's /deployments API rejects tunnel_id (HTTP 400 "unknown field"), so
			// a declared/inherited tunnel is dropped from the deployment payload and
			// server-side runs execute without it. Surface that degradation loudly.
			for (const [name, deployment] of Object.entries(config.deployments ?? {})) {
				if (deployment.provider && deployment.provider !== providerName) continue;
				const tunnel = deployment.tunnel ?? config.agents?.[deployment.agent]?.tunnel;
				const referencedAgent = config.agents?.[deployment.agent];
				if (referencedAgent?.delivery?.qoder?.type === "forward") {
					diagnostics.error(
						"qoder.deployment.forward_template.unsupported",
						`deployment.${name}: managed deployments cannot reference Forward-delivered agent '${deployment.agent}'.`,
						{ type: "deployment", name, provider: providerName },
					);
				}
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
				if (deployment.provider && deployment.provider !== providerName) continue;
				if (deployment.environment_variables !== undefined) {
					diagnostics.error(
						`${providerName}.deployment.environment_variables.unsupported`,
						`deployment.${name}: environment_variables is supported only by Qoder deployments; ` +
							`remove it or pin this deployment to the qoder provider.`,
						{ type: "deployment", name, provider: providerName },
					);
				}
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

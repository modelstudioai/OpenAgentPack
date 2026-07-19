import { UserError } from "../errors.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../providers/interface.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";

export function resolveRef(state: IStateManager, address: ResourceAddress): string | null | undefined {
	return state.getResource(address)?.remote_id;
}

export function requireRef(state: IStateManager, address: ResourceAddress): string {
	const id = resolveRef(state, address);
	if (!id) {
		throw new UserError(
			`Resource ${address.provider}.${address.type}.${address.name} not found in state. Run \`agents apply\` first.`,
		);
	}
	return id;
}

export function resolveAgentRefs(
	agentName: string,
	config: ProjectConfig,
	provider: string,
	state: IStateManager,
): ResolvedAgentRefs {
	const agent = config.agents?.[agentName];
	if (!agent) throw new UserError(`Agent '${agentName}' not found in config`);

	const refs: ResolvedAgentRefs = {
		skill_ids: [],
	};

	if (agent.skills) {
		for (const skill of agent.skills) {
			if (typeof skill === "string") {
				const id = requireRef(state, { type: "skill", name: skill, provider });
				refs.skill_ids.push({ type: "custom", skill_id: id });
			} else {
				// For custom skills, resolve the skill_id (YAML key) to its remote_id
				// from state. Official skills use their skill_id directly as the remote ID.
				const resolvedId =
					skill.type === "custom"
						? (resolveRef(state, {
								type: "skill",
								name: skill.skill_id,
								provider,
							}) ?? skill.skill_id)
						: skill.skill_id;
				refs.skill_ids.push({
					type: skill.type,
					skill_id: resolvedId,
					version: skill.version,
				});
			}
		}
	}

	if (agent.multiagent) {
		refs.multiagent_agent_ids = [];
		for (const subName of agent.multiagent.agents) {
			const id = resolveRef(state, { type: "agent", name: subName, provider });
			if (id) refs.multiagent_agent_ids.push(id);
		}
	}

	return refs;
}

export function resolveDeploymentRefs(
	deploymentName: string,
	config: ProjectConfig,
	provider: string,
	state: IStateManager,
): ResolvedDeploymentRefs {
	const dep = config.deployments?.[deploymentName];
	if (!dep) throw new UserError(`Deployment '${deploymentName}' not found in config`);

	const agent = config.agents?.[dep.agent];
	if (!agent) {
		throw new UserError(`Deployment '${deploymentName}' references unknown agent '${dep.agent}'`);
	}

	const agent_id = requireRef(state, {
		type: "agent",
		name: dep.agent,
		provider,
	});

	const envName = dep.environment ?? agent.environment;
	if (!envName) {
		throw new UserError(
			`Deployment '${deploymentName}' has no environment and agent '${dep.agent}' does not declare one`,
		);
	}
	const envDecl = config.environments?.[envName];
	if (!envDecl) {
		throw new UserError(`Environment '${envName}' is not defined in config.`);
	}
	const environment_id =
		envDecl.environment_id ??
		requireRef(state, {
			type: "environment",
			name: envName,
			provider,
		});

	const tunnelName = dep.tunnel ?? agent.tunnel;
	const tunnel_id = tunnelName ? resolveTunnelIdFromConfig(config, tunnelName, provider) : undefined;

	const vaultNames = dep.vaults ?? (agent.vault ? [agent.vault] : []);
	const vault_ids = vaultNames.map((v) => requireRef(state, { type: "vault", name: v, provider }));

	// Memory stores: union of the deployment's explicit list and any memory_store
	// resources; inherit the agent's stores only when the deployment names none.
	const msNames = new Set<string>();
	for (const m of dep.memory_stores ?? []) msNames.add(m);
	for (const r of dep.resources ?? []) {
		if (r.type === "memory_store") msNames.add(r.memory_store);
	}
	if (msNames.size === 0) {
		for (const m of agent.memory_stores ?? []) msNames.add(m);
	}

	const memory_store_ids: Record<string, string> = {};
	for (const m of msNames) {
		memory_store_ids[m] = requireRef(state, {
			type: "memory_store",
			name: m,
			provider,
		});
	}

	return {
		agent_id,
		agent_version: dep.agent_version,
		environment_id,
		tunnel_id,
		vault_ids,
		memory_store_ids,
	};
}

function resolveTunnelIdFromConfig(config: ProjectConfig, tunnelName: string, provider: string): string {
	if (provider !== "qoder") {
		throw new UserError("Tunnels are supported only by Qoder BYOC sessions.");
	}
	const tunnel = config.tunnels?.[tunnelName];
	if (!tunnel) {
		throw new UserError(`Tunnel '${tunnelName}' is not defined in config. Declare it under the 'tunnels:' section.`);
	}
	return tunnel.tunnel_id;
}

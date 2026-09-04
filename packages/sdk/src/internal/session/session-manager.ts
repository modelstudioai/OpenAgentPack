import { resolveAgentMaterialization } from "../core/agent-materialization.ts";
import { UserError } from "../errors.ts";
import { requireRef } from "../executor/resolver.ts";
import { getProvider } from "../providers/registry.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { AgentDecl, ProjectConfig, SessionResourceDecl } from "../types/config.ts";
import type { SessionBindings } from "../types/session.ts";
import { resolveSandboxMountPath } from "../utils/sandbox-mount.ts";

export interface SessionCreateOptions {
	/** Explicit provider Identity id. Overrides the declared defaults.identity reference. */
	identityId?: string;
	environment?: string;
	/**
	 * Explicit remote environment id. When set, it is bound directly (bypassing the
	 * config-name → state resolution), letting callers that already hold a provider
	 * environment id (e.g. the webui) pin the sandbox without declaring it in config.
	 * Takes precedence over `environment` / the agent's declared environment.
	 */
	environmentId?: string;
	/** Tunnel name referencing `tunnels.<name>` in config. */
	tunnel?: string;
	/** Explicit remote tunnel id. Takes precedence over `tunnel` / the agent's declared tunnel. */
	tunnelId?: string;
	vault?: string;
	/**
	 * Explicit remote vault ids. When set, they are bound directly (bypassing the
	 * config-name → state resolution), letting callers that already hold provider
	 * vault ids (e.g. the webui) bind a user-supplied credential vault without
	 * declaring it in config. Takes precedence over `vault` / the agent's vault.
	 */
	vaultIds?: string[];
	memoryStores?: string[];
	/** Uploaded files to mount as session resources, so the task can read the user's files. */
	files?: { fileId: string; mountPath: string }[];
	/** Explicit resources override the resources declared on the agent. */
	resources?: SessionResourceDecl[];
	title?: string;
	provider?: string;
	metadata?: Record<string, string>;
	/** Session-level environment variables. Currently supported by Qoder. */
	environmentVariables?: Record<string, string>;
}

export function resolveSessionProvider(agentName: string, config: ProjectConfig, overrideProvider?: string): string {
	const agent = config.agents?.[agentName];
	if (!agent) {
		const available = Object.keys(config.agents ?? {}).join(", ");
		throw new UserError(`Agent '${agentName}' not found in config. Available agents: ${available || "(none)"}`);
	}

	if (overrideProvider) return overrideProvider;
	if (agent.provider) return agent.provider;

	const defaultProvider = config.defaults?.provider;
	if (defaultProvider && defaultProvider !== "all") return defaultProvider;

	const providers = Object.keys(config.providers);
	if (providers.length === 1) return providers[0]!;

	throw new UserError(`Agent '${agentName}' is deployed to multiple providers. Use --provider to specify one.`);
}

export function buildSessionBindings(
	agentName: string,
	config: ProjectConfig,
	provider: string,
	state: IStateManager,
	options: SessionCreateOptions = {},
): SessionBindings {
	const agent = config.agents?.[agentName];
	if (!agent) {
		const available = Object.keys(config.agents ?? {}).join(", ");
		throw new UserError(`Agent '${agentName}' not found in config. Available agents: ${available || "(none)"}`);
	}
	const sessionResources = options.resources ?? agent.resources;
	const sessionFiles = resolveSessionFiles(agentName, agent, provider, state, options.files ?? []);
	const environmentVariables = options.environmentVariables ?? agent.environment_variables;
	if (environmentVariables && provider !== "qoder") {
		throw new UserError("Session environment variables are supported only by Qoder.");
	}
	const providerFeatures = getProvider(provider)?.features;
	for (const resource of sessionResources ?? []) {
		if (!providerFeatures?.session_resources.includes(resource.type)) {
			throw new UserError(
				`Provider '${provider}' does not support Session resource type '${resource.type}' for agent '${agentName}'.`,
			);
		}
	}
	if (resolveAgentMaterialization(provider, agent).resourceType === "template") {
		if (sessionResources?.length) {
			throw new UserError(
				`Forward session for '${agentName}' cannot attach Agent resources. Use managed delivery for GitHub repositories.`,
			);
		}
		const templateId = requireRef(state, { type: "template", name: agentName, provider });
		const defaultIdentity = config.defaults?.identity;
		const identityId =
			options.identityId ??
			(defaultIdentity ? requireRef(state, { type: "identity", name: defaultIdentity, provider }) : undefined);
		if (!identityId) {
			throw new UserError(
				`Forward session for '${agentName}' requires an Identity. Configure defaults.identity or pass --identity-id.`,
			);
		}
		return {
			delivery: "forward",
			template_id: templateId,
			identity_id: identityId,
			files: sessionFiles,
			title: options.title,
			metadata: options.metadata,
			environment_variables: environmentVariables,
		};
	}

	const agentId = requireRef(state, { type: "agent", name: agentName, provider });
	const agentState = state.getResource({ type: "agent", name: agentName, provider });

	const envName = options.environment ?? agent.environment;
	let environmentId: string;
	if (options.environmentId) {
		// Caller supplied a concrete remote id — bind it as-is. The id is authoritative,
		// so the config-name lookup and state resolution are skipped.
		environmentId = options.environmentId;
	} else {
		if (!envName) {
			throw new UserError(`Agent '${agentName}' has no environment declared and --environment was not specified.`);
		}
		validateResourceInConfig(envName, "environment", config.environments);
		const envDecl = config.environments![envName]!;
		environmentId = envDecl.environment_id ?? requireRef(state, { type: "environment", name: envName, provider });
	}

	const tunnelId = resolveTunnelId(agent, config, options, provider);

	let vaultIds: string[];
	if (options.vaultIds) {
		// Caller supplied concrete remote ids — bind them as-is, skipping the
		// config-name lookup and state resolution.
		vaultIds = options.vaultIds;
	} else {
		vaultIds = [];
		const vaultName = options.vault ?? agent.vault;
		if (vaultName) {
			validateResourceInConfig(vaultName, "vault", config.vaults);
			vaultIds.push(requireRef(state, { type: "vault", name: vaultName, provider }));
		}
	}

	const msNames = options.memoryStores ?? agent.memory_stores ?? [];
	const memoryStoreIds: string[] = [];
	for (const msName of msNames) {
		validateResourceInConfig(msName, "memory_store", config.memory_stores);
		memoryStoreIds.push(requireRef(state, { type: "memory_store", name: msName, provider }));
	}

	return {
		agent_id: agentId,
		agent_version: agentState?.version,
		environment_id: environmentId,
		tunnel_id: tunnelId,
		vault_ids: vaultIds,
		memory_store_ids: memoryStoreIds,
		files: sessionFiles,
		resources: sessionResources,
		title: options.title,
		metadata: options.metadata,
		environment_variables: environmentVariables,
	};
}

function resolveSessionFiles(
	agentName: string,
	agent: AgentDecl,
	provider: string,
	state: IStateManager,
	explicitFiles: Array<{ fileId: string; mountPath: string }>,
): Array<{ file_id: string; mount_path: string }> {
	const resolved: Array<{ file_id: string; mount_path: string }> = [];
	const mountOwners = new Map<string, string>();
	for (const file of agent.files ?? []) {
		const mountPath = resolveSandboxMountPath(provider, file.mount_path);
		assertUniqueMountPath(mountOwners, mountPath, `declared file '${file.file}'`, agentName);
		resolved.push({
			file_id: requireRef(state, { type: "file", name: file.file, provider }),
			mount_path: mountPath,
		});
	}
	for (const file of explicitFiles) {
		const mountPath = resolveSandboxMountPath(provider, file.mountPath);
		assertUniqueMountPath(mountOwners, mountPath, `Session file '${file.fileId}'`, agentName);
		resolved.push({ file_id: file.fileId, mount_path: mountPath });
	}
	return resolved;
}

function assertUniqueMountPath(
	mountOwners: Map<string, string>,
	mountPath: string,
	owner: string,
	agentName: string,
): void {
	const existing = mountOwners.get(mountPath);
	if (existing) {
		throw new UserError(
			`Agent '${agentName}' cannot mount ${owner} at '${mountPath}'; the path is already used by ${existing}.`,
		);
	}
	mountOwners.set(mountPath, owner);
}

function resolveTunnelId(
	agent: AgentDecl,
	config: ProjectConfig,
	options: SessionCreateOptions,
	provider: string,
): string | undefined {
	const tunnelName = options.tunnel ?? agent.tunnel;
	if (!options.tunnelId && !tunnelName) return undefined;
	if (provider !== "qoder") {
		throw new UserError("Tunnels are supported only by Qoder BYOC sessions.");
	}
	if (options.tunnelId) return options.tunnelId;

	const tunnel = config.tunnels?.[tunnelName!];
	if (!tunnel) {
		throw new UserError(`Tunnel '${tunnelName}' is not defined in config. Declare it under the 'tunnels:' section.`);
	}
	return tunnel.tunnel_id;
}

function validateResourceInConfig(name: string, type: string, resources?: Record<string, unknown>): void {
	if (!resources?.[name]) {
		throw new UserError(`${type} '${name}' is not defined in config.`);
	}
}

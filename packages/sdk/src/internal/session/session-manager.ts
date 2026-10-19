import { resolveAgentMaterialization } from "../core/agent-materialization.ts";
import { UserError } from "../errors.ts";
import { requireRef } from "../executor/resolver.ts";
import { sessionResourcesSchema } from "../parser/schema.ts";
import { getProvider } from "../providers/registry.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { AgentDecl, ProjectConfig, SessionResourceDecl } from "../types/config.ts";
import type { SessionBindings, SessionMemoryStoreResource, SessionResource } from "../types/session.ts";
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
	/** Session-level environment variables. Supported by Bailian and Qoder. */
	environmentVariables?: Record<string, string>;
}

/** Validate user-provided Session resources without loading a project or credentials. */
export function parseSessionResources(input: unknown): SessionResourceDecl[] {
	const parsed = sessionResourcesSchema.safeParse(input);
	if (!parsed.success) {
		const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
		throw new UserError(`Invalid Session resources / 会话资源配置无效: ${details}`);
	}
	return parsed.data;
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
	if (sessionResources) {
		// Keep the existing Git runtime contract, including scp-like SSH remotes.
		parseSessionResources(sessionResources.filter((resource) => resource.type === "memory_store"));
	}
	const sessionFiles = resolveSessionFiles(agentName, agent, provider, state, options.files ?? []);
	// Agent defaults remain Qoder-only; Bailian variables must be supplied for this Session.
	if (options.environmentVariables === undefined && agent.environment_variables !== undefined && provider !== "qoder") {
		throw new UserError(
			"Agent environment_variables defaults are supported only by Qoder; pass explicit Session environmentVariables instead. / Agent 的 environment_variables 默认值仅支持 Qoder；请在创建 Session 时显式传入环境变量。",
		);
	}
	const environmentVariables = options.environmentVariables ?? agent.environment_variables;
	if (environmentVariables && provider !== "qoder" && provider !== "bailian") {
		throw new UserError(
			"Session environment variables are supported only by Bailian and Qoder / 会话环境变量仅支持百炼和 Qoder。",
		);
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

	const memoryBindings = resolveSessionMemoryStores(
		config,
		provider,
		state,
		options.memoryStores ?? agent.memory_stores ?? [],
		sessionResources,
	);

	return {
		agent_id: agentId,
		agent_version: agentState?.version,
		environment_id: environmentId,
		tunnel_id: tunnelId,
		vault_ids: vaultIds,
		memory_store_ids: memoryBindings.memoryStoreIds,
		files: sessionFiles,
		resources: memoryBindings.resources,
		title: options.title,
		metadata: options.metadata,
		environment_variables: environmentVariables,
	};
}

function resolveSessionMemoryStores(
	config: ProjectConfig,
	provider: string,
	state: IStateManager,
	legacyNames: string[],
	declaredResources?: SessionResourceDecl[],
): { memoryStoreIds: string[]; resources?: SessionResource[] } {
	const resolveStoreId = (name: string): string => {
		validateResourceInConfig(name, "memory_store", config.memory_stores);
		const declaration = config.memory_stores![name]!;
		if (declaration.provider && declaration.provider !== provider) {
			throw new UserError(
				`Memory Store '${name}' belongs to provider '${declaration.provider}', not '${provider}' / 记忆库与会话的服务商不一致。`,
			);
		}
		const address = { type: "memory_store" as const, name, provider };
		if (state.getResource(address)?.memory_initialization) {
			throw new UserError(
				`Memory Store '${name}' initialization must complete before creating a Session / 记忆库初始化尚未完成，请先完成 apply。`,
			);
		}
		return requireRef(state, address);
	};
	const memoryStoreIds = legacyNames.map(resolveStoreId);
	if (provider !== "bailian") {
		return {
			memoryStoreIds,
			resources: declaredResources?.filter((resource) => resource.type === "github_repository"),
		};
	}

	const mounts = new Map<string, SessionMemoryStoreResource>();
	for (const storeId of memoryStoreIds) {
		mounts.set(storeId, { type: "memory_store", memory_store_id: storeId, access: "read_write" });
	}
	const explicitIds = new Set<string>();
	for (const resource of declaredResources ?? []) {
		if (resource.type !== "memory_store") continue;
		if (resource.access !== undefined && resource.access !== "read_only" && resource.access !== "read_write") {
			throw new UserError(
				"Memory Store access must be read_only or read_write / 记忆库访问权限必须是 read_only 或 read_write。",
			);
		}
		if (resource.instructions !== undefined && resource.instructions.length > 4096) {
			throw new UserError(
				"Memory Store instructions must not exceed 4096 characters / 记忆库挂载说明不能超过 4096 字符。",
			);
		}
		const storeId = resolveStoreId(resource.memory_store);
		if (explicitIds.has(storeId)) {
			throw new UserError(
				`Memory Store '${resource.memory_store}' is declared more than once in Session resources / 会话资源中不能重复声明同一记忆库。`,
			);
		}
		explicitIds.add(storeId);
		mounts.set(storeId, {
			type: "memory_store",
			memory_store_id: storeId,
			access: resource.access ?? "read_write",
			...(resource.instructions !== undefined ? { instructions: resource.instructions } : {}),
		});
	}
	if (mounts.size > 8) {
		throw new UserError("A Bailian Session can mount at most 8 Memory Stores / 百炼会话最多挂载 8 个记忆库。");
	}
	const resolvedResources: SessionResource[] = [
		...(declaredResources?.filter((resource) => resource.type === "github_repository") ?? []),
		...mounts.values(),
	];
	return {
		memoryStoreIds: [...mounts.keys()],
		...(declaredResources !== undefined || resolvedResources.length ? { resources: resolvedResources } : {}),
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
		if (typeof file === "string") continue;
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

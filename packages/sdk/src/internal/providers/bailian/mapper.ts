import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	CredentialDecl,
	DeploymentDecl,
	EnvironmentDecl,
	InitialEventDecl,
	ModelSpec,
	VaultDecl,
} from "../../types/config.ts";
import type { SessionBindings } from "../../types/session.ts";
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../interface.ts";
import { injectMetadata, secretPlaceholder } from "../sync-mapping.ts";

export function mapEnvironment(name: string, decl: EnvironmentDecl, projectName?: string): unknown {
	const config: Record<string, unknown> = { type: "cloud" };
	// Bailian's API only accepts networking.type "unrestricted" (a `limited`
	// request is rejected with HTTP 500 "must be one of [unrestricted]"). Fail
	// loudly instead of silently dropping the restriction — silently widening a
	// declared network boundary to unrestricted is a security footgun.
	const requested = decl.config.networking?.type;
	if (requested && requested !== "unrestricted") {
		throw new UserError(
			`environment '${name}': Bailian only supports networking.type 'unrestricted', but '${requested}' was declared. ` +
				`Bailian sandboxes cannot restrict egress; remove the networking restriction or deploy this environment to a provider that supports it (claude/qoder).`,
		);
	}
	config.networking = { type: "unrestricted" };
	if (decl.config.packages) config.packages = decl.config.packages;

	const body: Record<string, unknown> = {
		name,
		scope: "organization",
		config,
	};
	if (projectName) body.metadata = injectMetadata(decl.metadata, projectName, name);
	else if (decl.metadata) body.metadata = decl.metadata;
	if (decl.description) body.description = decl.description;
	return body;
}

export function mapVault(name: string, decl: VaultDecl, projectName?: string): unknown {
	const body: Record<string, unknown> = {
		display_name: decl.display_name,
	};
	if (projectName) body.metadata = injectMetadata(decl.metadata, projectName, name);
	else if (decl.metadata) body.metadata = decl.metadata;
	return body;
}

export function mapCredential(cred: CredentialDecl): unknown {
	// Bailian's credentials API currently only accepts `environment_variable`
	// authType; `static_bearer` is rejected with CREDENTIAL_AUTH_TYPE_ERROR.
	if (cred.type === "environment_variable") {
		return {
			auth: {
				type: "environment_variable",
				secret_name: cred.secret_name,
				secret_value: cred.secret_value,
				networking: cred.networking ?? { type: "unrestricted" },
			},
			display_name: cred.name,
		};
	}
	return {
		auth: {
			type: cred.type,
			token: cred.access_token,
			mcp_server_url: cred.mcp_server_url,
		},
		display_name: cred.name,
	};
}

// --- Reverse mapping (remote -> agents.yaml decl), used by `agents sync` ---

/**
 * Reverse-map a remote Bailian CredentialDTO into a credential decl. Bailian's
 * `auth` object echoes non-sensitive fields (type / secret_name / mcp_server_url
 * / networking) but never the secret, so the secret is a `${ENV}` placeholder.
 */
export function credToDecl(raw: Record<string, unknown>, vaultName: string): CredentialDecl {
	const auth = (raw.auth ?? {}) as Record<string, unknown>;
	const name = (raw.display_name as string) || (raw.id as string) || "credential";
	const placeholder = secretPlaceholder(vaultName, name);

	if (auth.type === "static_bearer") {
		return {
			name,
			type: "static_bearer",
			mcp_server_url: (auth.mcp_server_url as string) ?? "",
			access_token: placeholder,
		};
	}

	// Default to environment_variable (Bailian's accepted credential type).
	const networking = auth.networking as { type: "unrestricted" | "limited" } | undefined;
	return {
		name,
		type: "environment_variable",
		secret_name: (auth.secret_name as string) ?? name,
		secret_value: placeholder,
		networking: networking ?? { type: "unrestricted" },
	};
}

/** Reverse-map a remote VaultDTO (+ its credentials) into a vault decl. */
export function vaultToDecl(
	raw: Record<string, unknown>,
	rawCredentials: Array<Record<string, unknown>>,
	resourceName: string,
): Record<string, unknown> {
	return compactDeep({
		display_name: raw.display_name ?? resourceName,
		credentials: rawCredentials.map((c) => credToDecl(c, resourceName)),
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

/** Reverse-map a remote file into a FileDecl-shaped object for agents.yaml. */
export function fileToDecl(raw: Record<string, unknown>, filename: string): Record<string, unknown> {
	return compactDeep({
		source: filename,
		name: raw.filename as string | undefined,
		purpose: raw.purpose as string | undefined,
	}) as Record<string, unknown>;
}

/** Reverse-map a remote skill into a SkillDecl-shaped object for agents.yaml. */
export function skillToDecl(raw: Record<string, unknown>, name: string): Record<string, unknown> {
	return compactDeep({
		source: `./skills/${name}/`,
		description: raw.description as string | undefined,
	}) as Record<string, unknown>;
}

/** Reverse-map a remote environment into an EnvironmentDecl-shaped object for agents.yaml. */
export function envToDecl(raw: Record<string, unknown>): Record<string, unknown> {
	const config = (raw.config ?? {}) as Record<string, unknown>;
	return compactDeep({
		description: raw.description as string | undefined,
		config: {
			type: config.type ?? "cloud",
			networking: config.networking,
			packages: config.packages,
		},
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

/** Reverse-map a remote agent into an AgentDecl-shaped object for agents.yaml. */
export function agentToDecl(raw: Record<string, unknown>): Record<string, unknown> {
	const tools = raw.tools as Array<Record<string, unknown>> | undefined;
	const mcpServers = raw.mcp_servers as Array<Record<string, unknown>> | undefined;
	const skills = raw.skills as Array<Record<string, unknown>> | undefined;

	// Reverse-map tools: extract builtin names from builtin_toolkit configs
	let builtinTools: string[] | undefined;
	if (tools?.length) {
		const toolset = tools.find((t) => t.type === "builtin_toolkit");
		if (toolset) {
			const configs = (toolset.configs ?? []) as Array<{ name: string; enabled?: boolean }>;
			builtinTools = configs.filter((c) => c.enabled !== false).map((c) => c.name);
		}
	}

	// Reverse-map MCP servers
	let mcpServerDecls: Array<Record<string, unknown>> | undefined;
	if (mcpServers?.length) {
		mcpServerDecls = mcpServers.map((s) => ({
			name: s.name as string,
			type: s.type as string,
		}));
	}

	// Reverse-map skills (Bailian uses "customer" for custom type)
	let skillDecls: Array<Record<string, unknown>> | undefined;
	if (skills?.length) {
		skillDecls = skills.map((s) => ({
			type: (s.type as string) === "customer" ? "custom" : (s.type as string),
			skill_id: s.skill_id as string,
			version: s.version as string | undefined,
		}));
	}

	// Reverse-map model
	const model = raw.model as Record<string, unknown> | string | undefined;
	const modelValue = typeof model === "object" && model ? model.id : model;

	return compactDeep({
		description: raw.description as string | undefined,
		model: modelValue,
		instructions: raw.system as string | undefined,
		tools: builtinTools?.length ? { builtin: builtinTools } : undefined,
		mcp_servers: mcpServerDecls,
		skills: skillDecls,
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

export function mapAgent(
	name: string,
	decl: AgentDecl,
	refs: ResolvedAgentRefs,
	version?: number,
	projectName?: string,
	skillVersions?: Record<string, string>,
): unknown {
	let modelId: string;
	if (typeof decl.model === "string") {
		modelId = decl.model;
	} else {
		const bailianModel: ModelSpec | undefined = decl.model.bailian;
		if (!bailianModel) throw new UserError(`No Bailian model specified for agent '${name}'`);
		modelId = typeof bailianModel === "string" ? bailianModel : bailianModel.id;
	}

	const body: Record<string, unknown> = {
		name,
		model: { id: modelId },
		system: decl.instructions,
	};

	if (version !== undefined) body.version = version;
	if (decl.description) body.description = decl.description;

	if (projectName) {
		body.metadata = injectMetadata(decl.metadata, projectName, name);
	} else if (decl.metadata) {
		body.metadata = decl.metadata;
	}

	// Tools: builtin_toolkit + mcp_toolkit blocks
	const BAILIAN_BUILTINS = new Set(["bash", "read", "write", "edit", "glob", "grep", "download_file"]);
	if (decl.tools) {
		const toolConfigs = decl.tools.builtin
			.filter((t) => BAILIAN_BUILTINS.has(t))
			.map((toolName) => ({
				name: toolName,
				enabled: true,
			}));
		body.tools = [
			{
				type: "builtin_toolkit",
				default_config: { enabled: false },
				configs: toolConfigs,
			},
		];
	} else {
		body.tools = [
			{
				type: "builtin_toolkit",
				default_config: { enabled: true },
				configs: [],
			},
		];
	}

	// MCP servers + MCP toolkit tool entries
	if (decl.mcp_servers?.length) {
		body.mcp_servers = decl.mcp_servers.map((s) => ({
			type: "official",
			name: s.name,
		}));
		const tools = body.tools as unknown[];
		for (const s of decl.mcp_servers) {
			const mcpTool = decl.tools?.mcp?.find((t) => t.mcp_server_name === s.name);
			if (!mcpTool) {
				throw new UserError(`Bailian MCP server '${s.name}' requires a matching tools.mcp entry`);
			}
			tools.push({
				type: "mcp_toolkit",
				// AgentStudio REST validates snake_case.
				mcp_server_name: s.name,
				default_config: mcpTool.default_config ?? { enabled: false },
				configs: mcpTool.configs,
			});
		}
	}

	// Skills
	if (refs.skill_ids.length) {
		body.skills = refs.skill_ids.map((s) => ({
			// Bailian's SkillType enum is "customer" | "official"; map the
			// resolver's generic "custom" sentinel to "customer".
			type: s.type === "custom" ? "customer" : s.type,
			skill_id: s.skill_id,
			// Bailian composes `{skill_id}@{version}` internally and rejects
			// entries without a version. Prefer explicit external references, then
			// the latest active remote version, then the common initial version.
			version: s.version ?? skillVersions?.[s.skill_id] ?? "1.0",
		}));
	}

	return body;
}

export function mapSession(bindings: SessionBindings): unknown {
	const body: Record<string, unknown> = {
		agent: bindings.agent_id,
		environment_id: bindings.environment_id,
	};

	if (bindings.title) body.title = bindings.title;
	if (bindings.metadata) body.metadata = bindings.metadata;
	// Bind the credential vault(s) via the top-level `vault_ids` array — the shape the
	// real console (bailian-managed-agents createSession) sends and the downstream
	// vault→sandbox injection reads. The actual injection happens downstream (user-owned).
	// User-uploaded files mount through the `resources` array as `{type:"file",file_id}`.
	if (bindings.vault_ids.length) body.vault_ids = bindings.vault_ids;
	const resources: Record<string, unknown>[] = [];
	for (const f of bindings.files ?? []) resources.push({ type: "file", file_id: f.file_id, mount_path: f.mount_path });
	if (resources.length) body.resources = resources;
	if (bindings.memory_store_ids.length) body.memory_store_ids = bindings.memory_store_ids;

	return body;
}

export function mapDeploymentToSession(decl: DeploymentDecl, refs: ResolvedDeploymentRefs, fileIds: string[]): unknown {
	const body: Record<string, unknown> = {
		agent: refs.agent_id,
		environment_id: refs.environment_id,
	};

	if (decl.description) body.title = decl.description;

	if (fileIds.length) {
		const fileResources = (decl.resources ?? []).filter((r) => r.type === "file");
		body.resources = fileIds.map((id, index) => {
			const entry: Record<string, unknown> = { type: "file", file_id: id };
			const mountPath = fileResources[index]?.mount_path;
			if (mountPath) entry.mount_path = mountPath;
			return entry;
		});
	}

	return body;
}

export function mapInitialEvents(events: InitialEventDecl[]): unknown {
	const input = events
		.filter((e) => e.type === "user.message" || e.type === "system.message")
		.map((e) => ({
			role: "user",
			type: "message",
			content: [{ type: "text", text: (e as { content: string }).content }],
		}));
	return { input };
}

export function mapSendMessage(text: string): unknown {
	return {
		input: [
			{
				role: "user",
				type: "message",
				content: [{ type: "text", text }],
			},
		],
	};
}

export { toSessionEvent } from "./event-mapper.ts";

import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	CredentialDecl,
	DeploymentDecl,
	EnvironmentDecl,
	MemoryStoreDecl,
	ModelSpec,
	VaultDecl,
} from "../../types/config.ts";
import type { SessionEventType } from "../../types/dto.ts";
import type { SessionBindings } from "../../types/session.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import { resolveSandboxMountPath } from "../../utils/sandbox-mount.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../interface.ts";
import { injectMetadata, secretPlaceholder, slug } from "../sync-mapping.ts";

// Qoder's API expects builtin tool names in PascalCase. The configuration layer
// (agents.yaml / playbook JSON) uses snake_case or lowercase aliases and is
// converted mechanically. No per-tool overrides are applied.
function toPascalCase(name: string): string {
	return name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join("");
}

export function normalizeToolNameForQoder(name: string): string {
	return toPascalCase(name);
}

export function normalizeToolNameFromQoder(name: string): string {
	return name
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

export function mapEnvironment(name: string, decl: EnvironmentDecl, projectName: string): unknown {
	return {
		name,
		description: decl.description ?? "",
		config: {
			type: "cloud",
			networking: decl.config.networking ?? { type: "unrestricted" },
			packages: decl.config.packages,
		},
		metadata: injectMetadata(decl.metadata, projectName, name),
	};
}

// Qoder's create-vault endpoint accepts only display_name + metadata; credentials are
// added one-by-one via POST /vaults/{id}/credentials (see adapter.createVault).
export function mapVault(name: string, decl: VaultDecl, projectName: string): unknown {
	const body: Record<string, unknown> = { display_name: decl.display_name };
	if (projectName) body.metadata = injectMetadata(decl.metadata, projectName, name);
	else if (decl.metadata) body.metadata = decl.metadata;
	return body;
}

// A single credential for POST /vaults/{id}/credentials. Fields nest under `auth`;
// static_bearer uses `token`/`mcp_server_url`, environment_variable uses secret_name/value.
export function mapCredential(cred: CredentialDecl): unknown {
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
			mcp_server_url: cred.mcp_server_url,
			token: cred.access_token,
		},
		display_name: cred.name,
	};
}

// --- Reverse mapping (remote -> agents.yaml decl), used by `agents sync` ---

/**
 * Reverse-map a remote Qoder VaultCredential into a credential decl. The `auth`
 * object echoes non-sensitive fields (type / secret_name / mcp_server_url) but never
 * the secret, so the secret is a `${ENV}` placeholder. display_name may be null, so a
 * name is synthesized from mcp_server_url or the index.
 */
export function credToDecl(raw: Record<string, unknown>, vaultName: string, index: number): CredentialDecl {
	const auth = (raw.auth ?? {}) as Record<string, unknown>;
	const displayName = raw.display_name as string | null | undefined;

	if (auth.type === "static_bearer") {
		const name = displayName || slug(auth.mcp_server_url as string | undefined, `cred-${index + 1}`);
		const decl: CredentialDecl = {
			name,
			type: "static_bearer",
			mcp_server_url: (auth.mcp_server_url as string) ?? "",
			access_token: secretPlaceholder(vaultName, name),
		};
		if (typeof auth.protocol === "string") decl.protocol = auth.protocol as "sse" | "streamable_http";
		return decl;
	}

	// Default to environment_variable (Qoder's default credential type). Qoder never
	// echoes a credential display_name, so the env var's own name is the best identifier.
	const name = displayName || (auth.secret_name as string) || `cred-${index + 1}`;
	const networking = auth.networking as { type: "unrestricted" | "limited" } | undefined;
	const decl: CredentialDecl = {
		name,
		type: "environment_variable",
		secret_name: (auth.secret_name as string) ?? name,
		secret_value: secretPlaceholder(vaultName, name),
	};
	if (networking?.type) decl.networking = networking;
	return decl;
}

/** Reverse-map a remote Qoder vault (+ its credentials) into a vault decl. */
export function vaultToDecl(
	raw: Record<string, unknown>,
	rawCredentials: Array<Record<string, unknown>>,
	resourceName: string,
): Record<string, unknown> {
	return compactDeep({
		display_name: raw.display_name ?? raw.name ?? resourceName,
		credentials: rawCredentials.map((c, i) => credToDecl(c, resourceName, i)),
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

/** Reverse-map a remote skill into a SkillDecl-shaped object for agents.yaml. */
export function skillToDecl(raw: Record<string, unknown>, name: string): Record<string, unknown> {
	return compactDeep({
		source: `./skills/${name}/`,
		description: raw.description as string | undefined,
	}) as Record<string, unknown>;
}

/** Reverse-map a remote agent into an AgentDecl-shaped object for agents.yaml. */
export function agentToDecl(raw: Record<string, unknown>): Record<string, unknown> {
	const tools = raw.tools as Array<Record<string, unknown>> | undefined;
	const mcpServers = raw.mcp_servers as Array<Record<string, unknown>> | undefined;
	const skills = raw.skills as Array<Record<string, unknown>> | undefined;

	// Reverse-map tools: extract builtin names from agent_toolset_20260401 and
	// normalize API-side PascalCase names back to the snake_case configuration names.
	let builtinTools: string[] | undefined;
	if (tools?.length) {
		const toolset = tools.find((t) => t.type === "agent_toolset_20260401");
		if (toolset && Array.isArray(toolset.enabled_tools)) {
			builtinTools = (toolset.enabled_tools as string[]).map((t) => normalizeToolNameFromQoder(t));
		} else if (toolset) {
			const configs = (toolset.configs ?? []) as Array<{ name: string; enabled?: boolean }>;
			builtinTools = configs.filter((c) => c.enabled !== false).map((c) => normalizeToolNameFromQoder(c.name));
		}
	}

	// Reverse-map MCP servers
	let mcpServerDecls: Array<Record<string, unknown>> | undefined;
	if (mcpServers?.length) {
		mcpServerDecls = mcpServers.map((s) => ({
			name: s.name as string,
			type: s.type as string,
			url: s.url as string | undefined,
		}));
	}

	// Reverse-map skills
	let skillDecls: Array<Record<string, unknown>> | undefined;
	if (skills?.length) {
		skillDecls = skills.map((s) => ({
			type: (s.type as string) === "qoder" ? "official" : (s.type as string),
			skill_id: s.skill_id as string,
		}));
	}

	return compactDeep({
		description: raw.description as string | undefined,
		model: raw.model,
		instructions: raw.system as string | undefined,
		tools: builtinTools?.length ? { builtin: builtinTools } : undefined,
		mcp_servers: mcpServerDecls,
		skills: skillDecls,
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

export function mapMemoryStore(name: string, decl: MemoryStoreDecl): unknown {
	return {
		name,
		description: decl.description,
	};
}

export function mapAgent(
	name: string,
	decl: AgentDecl,
	refs: ResolvedAgentRefs,
	version?: number,
	projectName?: string,
): unknown {
	let model: string;
	if (typeof decl.model === "string") {
		model = decl.model;
	} else {
		const qoderModel: ModelSpec | undefined = decl.model.qoder;
		if (!qoderModel) throw new UserError(`No Qoder model specified for agent '${name}'`);
		model = typeof qoderModel === "string" ? qoderModel : qoderModel.id;
	}

	const body: Record<string, unknown> = {
		name,
		model,
		system: decl.instructions,
	};

	if (version !== undefined) body.version = version;
	if (decl.description) body.description = decl.description;
	if (projectName) {
		body.metadata = injectMetadata(decl.metadata, projectName, name);
	} else if (decl.metadata) {
		body.metadata = decl.metadata;
	}

	if (decl.tools) {
		const enabledTools = decl.tools.builtin.map((t) => normalizeToolNameForQoder(t));
		body.tools = [
			{
				type: "agent_toolset_20260401",
				enabled_tools: enabledTools,
			},
		];
	} else {
		body.tools = [{ type: "agent_toolset_20260401" }];
	}

	if (decl.mcp_servers?.length) {
		body.mcp_servers = decl.mcp_servers.map((s) => {
			if (s.type === "official" || !s.url) {
				throw new UserError(`Qoder MCP server '${s.name}' requires a url`);
			}
			return {
				name: s.name,
				type: "http",
				url: s.url,
			};
		});
		// Only add mcp_toolset tool entries when explicit configs are provided
		const tools = body.tools as unknown[];
		for (const s of decl.mcp_servers) {
			const mcpTool = decl.tools?.mcp?.find((t) => t.mcp_server_name === s.name);
			if (mcpTool) {
				tools.push({
					type: "mcp_toolset",
					mcp_server_name: s.name,
					configs: mcpTool.configs,
				});
			}
		}
	}

	// Skills
	if (refs.skill_ids.length) {
		body.skills = refs.skill_ids.map((s) => ({
			type: s.type === "official" ? "qoder" : s.type,
			skill_id: s.skill_id,
		}));
	}

	return body;
}

export function mapSendMessage(text: string): unknown {
	return {
		events: [{ type: "user.message", content: [{ type: "text", text }] }],
	};
}

const QODER_EVENT_MAP: Record<string, SessionEventType> = {
	"agent.message": "message",
	"user.message": "message",
	"agent.tool_use": "tool_use",
	"agent.tool_result": "tool_result",
	"agent.thinking": "thinking",
	"session.status_idle": "status",
	"session.status_running": "status",
	"session.thread_status_idle": "status",
	"session.error": "error",
};

export function toSessionEvent(raw: Record<string, unknown>): ProviderSessionEvent {
	const rawType = (raw.type as string) ?? "";
	const type: SessionEventType = QODER_EVENT_MAP[rawType] ?? "unknown";

	const event: ProviderSessionEvent = { type, raw_type: rawType, raw };
	if (typeof raw.role === "string") event.role = raw.role;

	if (type === "message") {
		// Real `agent.message` / `user.message` events carry no `role`; the actor
		// is encoded in the event type. Derive it so consumers can attribute turns.
		event.role = roleFromType(rawType, raw.role);
		event.content = extractContentText(raw);
	} else if (type === "tool_use") {
		event.tool_name = (raw.tool_name as string) ?? (raw.name as string) ?? "";
		event.tool_input =
			(raw.tool_input as string) ?? (typeof raw.input === "string" ? raw.input : JSON.stringify(raw.input ?? {}));
	} else if (type === "tool_result") {
		event.content = extractContentText(raw);
	} else if (type === "status") {
		// Only session-level idle/terminated are terminal; thread-level idle
		// (session.thread_status_idle) is non-terminal and should not stop the stream.
		if (rawType === "session.thread_status_idle") {
			event.status = "running";
		} else {
			event.status = rawType.includes("idle") ? "idle" : rawType.includes("terminated") ? "terminated" : "running";
		}
		event.stop_reason = extractStopReason(raw.stop_reason);
	} else if (type === "error") {
		event.content = extractErrorMessage(raw);
	}

	// `agent.artifact_delivered` is a structured delivery event (verified on the real qoder API to
	// carry file_id/original_filename/content_type/size). It stays "unknown" in QODER_EVENT_MAP on
	// purpose — the DeliverArtifacts tool_use/tool_result already show it in the timeline — but we
	// lift the structured file into `artifact` so the webui can render a download card.
	if (rawType === "agent.artifact_delivered") {
		const fileId = raw.file_id;
		if (typeof fileId === "string" && fileId) {
			event.artifact = {
				file_id: fileId,
				filename: typeof raw.original_filename === "string" ? raw.original_filename : undefined,
				content_type: typeof raw.content_type === "string" ? raw.content_type : undefined,
				size: typeof raw.size === "number" ? raw.size : undefined,
			};
		}
	}

	return event;
}

function roleFromType(rawType: string, rawRole: unknown): string | undefined {
	if (typeof rawRole === "string") return rawRole;
	if (rawType.startsWith("user.")) return "user";
	if (rawType.startsWith("agent.")) return "assistant";
	return undefined;
}

function extractContentText(raw: Record<string, unknown>): string {
	const content = raw.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: Record<string, unknown>) => (c.text as string) ?? "")
			.filter(Boolean)
			.join("");
	}
	return "";
}

function extractStopReason(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const type = (value as Record<string, unknown>).type;
		if (typeof type === "string") return type;
	}
	return undefined;
}

function extractErrorMessage(raw: Record<string, unknown>): string {
	const err = raw.error;
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const message = (err as Record<string, unknown>).message;
		if (typeof message === "string") return message;
	}
	if (typeof raw.message === "string") return raw.message;
	return "";
}

export function mapSession(bindings: SessionBindings): unknown {
	const body: Record<string, unknown> = {
		agent: bindings.agent_id,
		environment_id: bindings.environment_id,
	};

	if (bindings.title) body.title = bindings.title;
	if (bindings.metadata) body.metadata = bindings.metadata;
	if (bindings.vault_ids.length) body.vault_ids = bindings.vault_ids;
	// Memory stores and user-uploaded files share the `resources` array (vaults are separate
	// via `vault_ids`). Every entry needs a non-empty `type`; file shape mirrors qoder's
	// deployment mapping (`{ type: "file", file_id }`).
	const resources: Record<string, unknown>[] = [];
	for (const id of bindings.memory_store_ids) resources.push({ type: "memory_store", memory_store_id: id });
	for (const f of bindings.files ?? [])
		resources.push({ type: "file", file_id: f.file_id, mount_path: resolveSandboxMountPath("qoder", f.mount_path) });
	if (resources.length) body.resources = resources;

	return body;
}

export function mapDeploymentToSession(decl: DeploymentDecl, refs: ResolvedDeploymentRefs, fileIds: string[]): unknown {
	const body: Record<string, unknown> = {
		agent: refs.agent_id,
		environment_id: refs.environment_id,
	};

	if (decl.description) body.title = decl.description;
	if (refs.vault_ids.length) body.vault_ids = refs.vault_ids;

	const resources: Record<string, unknown>[] = Object.values(refs.memory_store_ids).map((id) => ({
		type: "memory_store",
		memory_store_id: id,
	}));
	// fileIds are positionally aligned with the decl's file resources, so the mount_path
	// from each `{ type: file, source, mount_path }` is recovered by index. Every entry
	// needs a non-empty `type` (the API rejects a bare `{ file_id }`).
	const fileResources = (decl.resources ?? []).filter((r) => r.type === "file");
	fileIds.forEach((id, index) => {
		const entry: Record<string, unknown> = { type: "file", file_id: id };
		const mountPath = fileResources[index]?.mount_path;
		if (mountPath) entry.mount_path = mountPath;
		resources.push(entry);
	});
	if (resources.length) body.resources = resources;

	return body;
}

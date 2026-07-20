import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	CredentialDecl,
	DeploymentDecl,
	EnvironmentDecl,
	MemoryStoreDecl,
	ModelSpec,
} from "../../types/config.ts";
import type { SessionEventType } from "../../types/dto.ts";
import type { ManagedSessionBindings } from "../../types/session.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../interface.ts";
import { normalizeWireResourceName } from "../resource-naming.ts";
import { injectMetadata, secretPlaceholder } from "../sync-mapping.ts";

// This provider is a fork of the claude provider (Anthropic Managed Agents). Ark mirrors
// that wire protocol almost byte-for-byte; the deliberate divergences are: Bearer auth,
// the `agent_toolset_20260701` builtin toolset, `model.ark` (doubao) sent as `{id}` only,
// native `/memory_stores`, and emulated deployment (materialized into a session at run
// time, like qoder). See openspec/changes/add-ark-provider/design.md.

const ARK_BUILTINS = new Set(["read", "write", "edit", "bash", "glob", "grep", "web_search", "web_fetch"]);

// --- Reverse mapping (remote -> agents.yaml decl), used by `agents sync` ---

export function credToDecl(raw: Record<string, unknown>, vaultName: string): CredentialDecl | null {
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

	if (auth.type === "environment_variable") {
		const networking = auth.networking as { type?: "unrestricted" | "limited" } | undefined;
		return {
			name,
			type: "environment_variable",
			secret_name: (auth.secret_name as string) ?? name,
			secret_value: placeholder,
			networking: {
				type: networking?.type === "limited" ? "limited" : "unrestricted",
			},
		};
	}

	// mcp_oauth (and any future types) cannot be expressed in the agents schema.
	return null;
}

export function vaultToDecl(
	raw: Record<string, unknown>,
	rawCredentials: Array<Record<string, unknown>>,
	resourceName: string,
): Record<string, unknown> {
	const credentials = rawCredentials
		.map((c) => credToDecl(c, resourceName))
		.filter((c): c is CredentialDecl => c !== null);
	return compactDeep({
		display_name: raw.display_name ?? resourceName,
		credentials,
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

export function fileToDecl(raw: Record<string, unknown>, filename: string): Record<string, unknown> {
	return compactDeep({
		source: filename,
		name: raw.filename as string | undefined,
		purpose: raw.purpose as string | undefined,
	}) as Record<string, unknown>;
}

export function skillToDecl(raw: Record<string, unknown>, name: string): Record<string, unknown> {
	const rawOrigin = raw.source as string | undefined;
	const origin = rawOrigin === "custom" ? "custom" : rawOrigin ? "official" : undefined;
	const displayName = (raw.display_title ?? raw.name ?? name) as string;
	return compactDeep({
		name: displayName !== name ? displayName : undefined,
		source: `./skills/${name}/`,
		description: raw.description as string | undefined,
		origin,
	}) as Record<string, unknown>;
}

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

export function agentToDecl(raw: Record<string, unknown>): Record<string, unknown> {
	const tools = raw.tools as Array<Record<string, unknown>> | undefined;
	const mcpServers = raw.mcp_servers as Array<Record<string, unknown>> | undefined;
	const skills = raw.skills as Array<Record<string, unknown>> | undefined;
	const multiagent = raw.multiagent as Record<string, unknown> | undefined;

	let builtinTools: string[] | undefined;
	let allToolsEnabled = false;
	if (tools?.length) {
		const toolset = tools.find((t) => t.type === "agent_toolset_20260701");
		if (toolset) {
			const defaultConfig = toolset.default_config as { enabled?: boolean } | undefined;
			const configs = (toolset.configs ?? []) as Array<{
				name: string;
				enabled?: boolean;
			}>;
			if (configs.length > 0) {
				builtinTools = configs.filter((c) => c.enabled !== false).map((c) => c.name);
			} else if (defaultConfig?.enabled) {
				allToolsEnabled = true;
			}
		}
	}

	let mcpServerDecls: Array<Record<string, unknown>> | undefined;
	if (mcpServers?.length) {
		mcpServerDecls = mcpServers.map((s) => ({
			name: s.name as string,
			type: s.type as string,
			url: s.url as string | undefined,
		}));
	}

	let skillDecls: Array<Record<string, unknown> | string> | undefined;
	if (skills?.length) {
		skillDecls = skills.map((s) => ({
			type: s.type as string,
			skill_id: s.skill_id as string,
		}));
	}

	let multiagentDecl: Record<string, unknown> | undefined;
	if (multiagent) {
		// Ark returns `agents` as AgentRef objects (`{type:"agent", id}`); normalize back
		// to id strings for the agents decl. Tolerate a bare-string array defensively.
		const rawAgents = multiagent.agents as Array<Record<string, unknown> | string> | undefined;
		if (rawAgents?.length) {
			const ids = rawAgents.map((a) => (typeof a === "string" ? a : (a.id as string))).filter(Boolean);
			if (ids.length) multiagentDecl = { type: "coordinator", agents: ids };
		}
	}

	let toolsDecl: Record<string, unknown> | undefined;
	if (builtinTools?.length) {
		toolsDecl = { builtin: builtinTools };
	} else if (allToolsEnabled) {
		toolsDecl = {
			builtin: ["read", "write", "edit", "bash", "glob", "grep", "web_search", "web_fetch"],
		};
	}

	return compactDeep({
		name: raw.name as string | undefined,
		description: raw.description as string | undefined,
		model: raw.model,
		instructions: raw.system as string | undefined,
		tools: toolsDecl,
		mcp_servers: mcpServerDecls,
		skills: skillDecls,
		multiagent: multiagentDecl,
		metadata: stripAgentsMetadata(raw.metadata),
	}) as Record<string, unknown>;
}

export function mapEnvironment(name: string, decl: EnvironmentDecl, projectName: string, wireName?: string): unknown {
	const remoteName = wireName ?? normalizeWireResourceName("ark", "environment", name);
	const body: Record<string, unknown> = {
		name: remoteName,
		config: {
			type: "cloud",
			networking: decl.config.networking ?? { type: "unrestricted" },
			packages: decl.config.packages,
		},
		metadata: injectMetadata(decl.metadata, projectName, name),
	};
	if (decl.description) body.description = decl.description;
	return body;
}

export function mapMemoryStore(name: string, decl: MemoryStoreDecl): unknown {
	return {
		name,
		description: decl.description,
		metadata: decl.metadata,
	};
}

export function mapAgent(
	name: string,
	decl: AgentDecl,
	refs: ResolvedAgentRefs,
	version?: number,
	projectName?: string,
): unknown {
	// Ark rejects a bare string model ("Mismatch type agent.ModelConfig with value
	// string"); it always requires the `{id}` object form. `speed` is left to the
	// server default (it echoes back `speed: "standard"`).
	let arkModel: ModelSpec | undefined;
	if (typeof decl.model === "string") {
		arkModel = decl.model;
	} else {
		arkModel = decl.model.ark;
	}
	if (!arkModel) throw new UserError(`No Ark model specified for agent '${name}'`);
	const modelValue = typeof arkModel === "string" ? { id: arkModel } : { id: arkModel.id };

	const body: Record<string, unknown> = {
		name,
		model: modelValue,
		system: decl.instructions,
	};

	if (version !== undefined) body.version = version;

	if (decl.description) body.description = decl.description;
	if (projectName) {
		body.metadata = injectMetadata(decl.metadata, projectName, name);
	} else if (decl.metadata) {
		body.metadata = decl.metadata;
	}

	// Tools
	if (decl.tools) {
		const toolConfigs = decl.tools.builtin
			.filter((toolName) => ARK_BUILTINS.has(toolName))
			.map((toolName) => {
				const permission = decl.tools?.permissions?.[toolName] ?? "allow";
				return {
					name: toolName,
					enabled: true,
					permission_policy: {
						type: permission === "ask" ? "always_ask" : "always_allow",
					},
				};
			});
		body.tools = [
			{
				type: "agent_toolset_20260701",
				default_config: { enabled: false },
				configs: toolConfigs,
			},
		];
	} else {
		body.tools = [{ type: "agent_toolset_20260701" }];
	}

	// MCP servers
	if (decl.mcp_servers?.length) {
		body.mcp_servers = decl.mcp_servers.map((s) => {
			if (s.type === "official" || !s.url) {
				throw new UserError(`Ark MCP server '${s.name}' requires a url`);
			}
			return {
				name: s.name,
				type: "url",
				url: s.url,
			};
		});
		const tools = body.tools as unknown[];
		for (const s of decl.mcp_servers) {
			tools.push({ type: "mcp_toolset", mcp_server_name: s.name });
		}
	}

	// Skills
	if (refs.skill_ids.length) {
		body.skills = refs.skill_ids.map((s) => ({
			type: s.type,
			skill_id: s.skill_id,
		}));
	}

	// Multiagent
	if (decl.multiagent && refs.multiagent_agent_ids?.length) {
		// Ark's `multiagent.agents` requires `AgentRef` objects (`{type:"agent", id}`),
		// not a bare id string array (bare strings → 400 "Mismatch type agent.AgentRef").
		body.multiagent = {
			type: "coordinator",
			agents: refs.multiagent_agent_ids.map((id) => ({ type: "agent", id })),
		};
	}

	return body;
}

// Emulated deployment: Ark has no /deployments endpoint, so a deployment is materialized
// into a session at run time (mirrors qoder). This maps the deployment's agent/environment/
// vault/memory_store/file bindings into a session-creation body.
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

export function mapSendMessage(text: string): unknown {
	return {
		events: [
			{
				type: "user.message",
				content: [{ type: "text", text }],
			},
		],
	};
}

const ARK_EVENT_MAP: Record<string, SessionEventType> = {
	"agent.message": "message",
	"user.message": "message",
	"agent.tool_use": "tool_use",
	"agent.mcp_tool_use": "tool_use",
	"agent.tool_result": "tool_result",
	"agent.mcp_tool_result": "tool_result",
	"agent.thinking": "thinking",
	"session.status_idle": "status",
	"session.status_running": "status",
	"session.status_terminated": "status",
	"session.error": "error",
};

export function toSessionEvent(raw: Record<string, unknown>): ProviderSessionEvent {
	const rawType = (raw.type as string) ?? "";
	const type: SessionEventType = ARK_EVENT_MAP[rawType] ?? "unknown";

	const event: ProviderSessionEvent = { type, raw_type: rawType, raw };

	if (type === "message") {
		event.role = roleFromType(rawType, raw.role);
		event.content = extractContentText(raw);
	} else if (type === "tool_use") {
		event.tool_name = (raw.name as string) ?? "";
		event.tool_input = typeof raw.input === "string" ? raw.input : JSON.stringify(raw.input ?? {});
	} else if (type === "tool_result") {
		event.content = extractContentText(raw);
	} else if (type === "status") {
		event.status = rawType.includes("idle") ? "idle" : rawType.includes("terminated") ? "terminated" : "running";
		event.stop_reason = extractStopReason(raw.stop_reason);
	} else if (type === "error") {
		event.content = extractErrorMessage(raw);
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

export function mapSession(bindings: ManagedSessionBindings): unknown {
	const body: Record<string, unknown> = {
		agent: bindings.agent_version
			? {
					id: bindings.agent_id,
					type: "agent",
					version: bindings.agent_version,
				}
			: bindings.agent_id,
		environment_id: bindings.environment_id,
	};

	if (bindings.title) body.title = bindings.title;
	if (bindings.metadata) body.metadata = bindings.metadata;
	if (bindings.vault_ids.length) body.vault_ids = bindings.vault_ids;

	const resources: Record<string, unknown>[] = [];
	for (const id of bindings.memory_store_ids) resources.push({ type: "memory_store", memory_store_id: id });
	for (const f of bindings.files ?? [])
		resources.push({
			type: "file",
			file_id: f.file_id,
			mount_path: f.mount_path,
		});
	if (resources.length) body.resources = resources;

	return body;
}

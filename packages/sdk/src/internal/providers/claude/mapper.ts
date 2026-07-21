import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	CredentialDecl,
	DeploymentDecl,
	EnvironmentDecl,
	InitialEventDecl,
	ModelSpec,
} from "../../types/config.ts";
import type { SessionEventType } from "../../types/dto.ts";
import type { ManagedSessionBindings } from "../../types/session.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../interface.ts";
import { injectMetadata, secretPlaceholder } from "../sync-mapping.ts";

// Claude's builtin tool vocabulary. Generic/bailian-native tool names not in this set
// (e.g. `download_file`, which has no Claude equivalent) are dropped on the write path
// rather than forwarded — the API rejects unknown tool names.
const CLAUDE_BUILTINS = new Set(["read", "write", "edit", "bash", "glob", "grep", "web_search", "web_fetch"]);

// --- Reverse mapping (remote -> agents.yaml decl), used by `agents sync` ---

/**
 * Reverse-map a remote Claude vault credential into a credential decl. Claude's
 * `auth` echoes non-sensitive fields (type / mcp_server_url / secret_name /
 * networking) but never the secret, so the secret is a `${ENV}` placeholder.
 * Returns null for `mcp_oauth`, which the agents credential schema cannot represent.
 */
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

/** Reverse-map a remote Claude vault (+ its credentials) into a vault decl. */
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
	const multiagent = raw.multiagent as Record<string, unknown> | undefined;

	// Reverse-map tools: extract builtin names from agent_toolset_20260401 configs
	let builtinTools: string[] | undefined;
	let allToolsEnabled = false;
	if (tools?.length) {
		const toolset = tools.find((t) => t.type === "agent_toolset_20260401");
		if (toolset) {
			const defaultConfig = toolset.default_config as { enabled?: boolean } | undefined;
			const configs = (toolset.configs ?? []) as Array<{
				name: string;
				enabled?: boolean;
			}>;
			if (configs.length > 0) {
				builtinTools = configs.filter((c) => c.enabled !== false).map((c) => c.name);
			} else if (defaultConfig?.enabled) {
				// All tools enabled by default, no specific configs listed
				allToolsEnabled = true;
			}
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
	let skillDecls: Array<Record<string, unknown> | string> | undefined;
	if (skills?.length) {
		skillDecls = skills.map((s) => ({
			type: s.type as string,
			skill_id: s.skill_id as string,
		}));
	}

	// Reverse-map multiagent
	let multiagentDecl: Record<string, unknown> | undefined;
	if (multiagent && (multiagent.agents as string[] | undefined)?.length) {
		multiagentDecl = { type: "coordinator", agents: multiagent.agents };
	}

	// Resolve tools declaration
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

export function mapEnvironment(name: string, decl: EnvironmentDecl, projectName: string): unknown {
	const body: Record<string, unknown> = {
		name,
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

export function mapAgent(
	name: string,
	decl: AgentDecl,
	refs: ResolvedAgentRefs,
	version?: number,
	projectName?: string,
): unknown {
	let modelValue: unknown;
	if (typeof decl.model === "string") {
		modelValue = decl.model;
	} else {
		const claudeModel: ModelSpec | undefined = decl.model.claude;
		if (!claudeModel) throw new UserError(`No Claude model specified for agent '${name}'`);
		if (typeof claudeModel === "string") {
			modelValue = claudeModel;
		} else {
			modelValue = {
				id: claudeModel.id,
				speed: claudeModel.speed ?? "standard",
			};
		}
	}

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
			.filter((toolName) => CLAUDE_BUILTINS.has(toolName))
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
				type: "agent_toolset_20260401",
				default_config: { enabled: false },
				configs: toolConfigs,
			},
		];
	} else {
		body.tools = [{ type: "agent_toolset_20260401" }];
	}

	// MCP servers
	if (decl.mcp_servers?.length) {
		body.mcp_servers = decl.mcp_servers.map((s) => {
			if (s.type === "official" || !s.url) {
				throw new UserError(`Claude MCP server '${s.name}' requires a url`);
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
		body.multiagent = {
			type: "coordinator",
			agents: refs.multiagent_agent_ids,
		};
	}

	return body;
}

export function mapDeployment(
	name: string,
	decl: DeploymentDecl,
	refs: ResolvedDeploymentRefs,
	projectName?: string,
	uploadedFiles?: Map<string, string>,
): unknown {
	const body: Record<string, unknown> = {
		name,
		agent:
			refs.agent_version !== undefined
				? { id: refs.agent_id, type: "agent", version: refs.agent_version }
				: refs.agent_id,
		environment_id: refs.environment_id,
		initial_events: mapInitialEvents(decl.initial_events),
	};

	if (refs.vault_ids.length) body.vault_ids = refs.vault_ids;

	const resources = mapDeploymentResources(decl, refs, uploadedFiles);
	if (resources.length) body.resources = resources;

	if (decl.schedule) {
		body.schedule = {
			type: "cron",
			expression: decl.schedule.expression,
			timezone: decl.schedule.timezone,
		};
	}

	if (decl.description) body.description = decl.description;

	if (projectName) {
		body.metadata = injectMetadata(decl.metadata, projectName, name);
	} else if (decl.metadata) {
		body.metadata = decl.metadata;
	}

	return body;
}

export function mapDeploymentUpdate(
	name: string,
	decl: DeploymentDecl,
	refs: ResolvedDeploymentRefs,
	projectName?: string,
	uploadedFiles?: Map<string, string>,
	existingMetadata?: Record<string, unknown>,
): unknown {
	const body = mapDeployment(name, decl, refs, projectName, uploadedFiles) as Record<string, unknown>;
	body.vault_ids = refs.vault_ids;
	body.resources = mapDeploymentResources(decl, refs, uploadedFiles);
	if (decl.schedule) {
		body.schedule = { type: "cron", expression: decl.schedule.expression, timezone: decl.schedule.timezone };
	}
	body.description = decl.description ?? "";
	const desiredMetadata = projectName ? injectMetadata(decl.metadata, projectName, name) : (decl.metadata ?? {});
	body.metadata = {
		...Object.fromEntries(
			Object.keys(existingMetadata ?? {})
				.filter((key) => !(key in desiredMetadata))
				.map((key) => [key, null]),
		),
		...desiredMetadata,
	};
	return body;
}

function mapInitialEvents(events: InitialEventDecl[]): unknown[] {
	return events.map((ev) => {
		if (ev.type === "user.message" || ev.type === "system.message") {
			return { type: ev.type, content: [{ type: "text", text: ev.content }] };
		}
		const out: Record<string, unknown> = { type: "user.define_outcome" };
		if (ev.description) out.description = ev.description;
		if (ev.rubric) {
			out.rubric = { type: "text", content: ev.rubric };
		} else if (ev.rubric_file) {
			out.rubric = { type: "file", file_id: ev.rubric_file };
		}
		if (ev.max_iterations !== undefined) out.max_iterations = ev.max_iterations;
		return out;
	});
}

function mapDeploymentResources(
	decl: DeploymentDecl,
	refs: ResolvedDeploymentRefs,
	uploadedFiles?: Map<string, string>,
): unknown[] {
	const resources: unknown[] = [];
	const seenStores = new Set<string>();

	for (const r of decl.resources ?? []) {
		if (r.type === "file") {
			const fileId = r.file_id ?? (r.source ? uploadedFiles?.get(r.source) : undefined);
			if (fileId) {
				const entry: Record<string, unknown> = {
					type: "file",
					file_id: fileId,
				};
				if (r.mount_path) entry.mount_path = r.mount_path;
				resources.push(entry);
			}
		} else if (r.type === "github_repository") {
			const entry: Record<string, unknown> = {
				type: "github_repository",
				url: r.url,
			};
			if (r.authorization_token) entry.authorization_token = r.authorization_token;
			if (r.checkout?.branch) {
				entry.checkout = { type: "branch", name: r.checkout.branch };
			} else if (r.checkout?.commit) {
				entry.checkout = { type: "commit", sha: r.checkout.commit };
			}
			if (r.mount_path) entry.mount_path = r.mount_path;
			resources.push(entry);
		} else if (r.type === "memory_store") {
			const id = refs.memory_store_ids[r.memory_store];
			if (id && !seenStores.has(id)) {
				seenStores.add(id);
				const entry: Record<string, unknown> = {
					type: "memory_store",
					memory_store_id: id,
				};
				if (r.access) entry.access = r.access;
				if (r.instructions) entry.instructions = r.instructions;
				resources.push(entry);
			}
		}
	}

	for (const m of decl.memory_stores ?? []) {
		const id = refs.memory_store_ids[m];
		if (id && !seenStores.has(id)) {
			seenStores.add(id);
			resources.push({ type: "memory_store", memory_store_id: id });
		}
	}

	return resources;
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

const CLAUDE_EVENT_MAP: Record<string, SessionEventType> = {
	"agent.message": "message",
	// The live AgentStudio/Managed-Agents stream replays the prompt as a
	// `user.message` event with NO `role` field; without this entry it maps to
	// "unknown" and the user's own turn vanishes from history.
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
	const type: SessionEventType = CLAUDE_EVENT_MAP[rawType] ?? "unknown";

	const event: ProviderSessionEvent = { type, raw_type: rawType, raw };

	if (type === "message") {
		// Real `agent.message` / `user.message` events carry no `role`; the actor
		// is encoded in the event type. Derive it so consumers can attribute turns.
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

	// Memory stores and user-uploaded files share the `resources` array (vaults are separate
	// via `vault_ids`). File shape mirrors claude's deployment mapping (`{ type:"file", file_id }`).
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

import type { AgentDecl, AgentMcpToolkitDecl, AgentSkillDecl, McpServerDecl, SkillDecl } from "../types/config.ts";

export interface AgentSkillBuildInput {
	kind: "official" | "custom";
	/** Skill code/id for official skills. */
	code?: string;
	version?: string;
	/** Name + source for custom (managed) skills. */
	name?: string;
	source?: string;
	description?: string;
}

export interface AgentMcpBuildInput {
	serverName: string;
	serverType: "official" | "url" | "http";
	serverUrl?: string;
	defaultEnabled?: boolean;
	tools: Array<{ name: string; enabled?: boolean }>;
}

export interface AgentBuildInput {
	description?: string;
	model?: AgentDecl["model"];
	instructions?: string;
	environment?: string;
	provider?: string;
	builtinTools?: string[];
	skills?: AgentSkillBuildInput[];
	mcp?: AgentMcpBuildInput[];
	metadata?: Record<string, string>;
}

export interface BuiltAgent {
	agent: AgentDecl;
	/** Custom skills referenced by the agent, to be merged into config.skills. */
	customSkills: Record<string, SkillDecl>;
}

/**
 * Construct a normalized AgentDecl by overlaying neutral override fields onto an
 * optional base agent. Owns the provider-specific encoding of tools/mcp/skills so
 * callers (e.g. a WebUI catalog) don't hand-assemble core's config shapes.
 */
export function buildAgentDecl(base: AgentDecl | undefined, input: AgentBuildInput): BuiltAgent {
	const model = input.model ?? base?.model;
	if (model === undefined) {
		throw new Error("buildAgentDecl: 'model' is required — provide input.model or a base agent with a model.");
	}

	const builtin =
		input.builtinTools && input.builtinTools.length > 0 ? input.builtinTools : (base?.tools?.builtin ?? []);
	const mcp = input.mcp ?? [];
	const customSkills: Record<string, SkillDecl> = {};

	const mcpToolkits: AgentMcpToolkitDecl[] = mcp.map((binding) => ({
		type: "mcp_toolkit",
		mcp_server_name: binding.serverName,
		default_config: { enabled: binding.defaultEnabled ?? false },
		configs: binding.tools.map((tool) => ({ name: tool.name, enabled: tool.enabled ?? true })),
	}));

	const mcpServers: McpServerDecl[] = mcp.map((binding) => ({
		name: binding.serverName,
		type: binding.serverType,
		url: binding.serverUrl,
	}));

	const skills: AgentSkillDecl[] = (input.skills ?? []).map((skill) => {
		if (skill.kind === "custom") {
			if (skill.name && skill.source) {
				customSkills[skill.name] = { source: skill.source, description: skill.description, provider: input.provider };
			}
			return skill.name ?? "";
		}
		return { type: "official", skill_id: skill.code ?? "", version: skill.version };
	});

	const agent: AgentDecl = {
		...(base ?? {}),
		description: input.description ?? base?.description,
		model,
		instructions: input.instructions ?? base?.instructions ?? "",
		...(input.environment ? { environment: input.environment } : {}),
		provider: input.provider ?? base?.provider,
		tools: {
			...(base?.tools ?? { builtin: [] }),
			builtin,
			mcp: mcpToolkits,
		},
		mcp_servers: mcpServers,
		skills,
		metadata: {
			...(base?.metadata ?? {}),
			...(input.metadata ?? {}),
		},
	};

	return { agent, customSkills };
}

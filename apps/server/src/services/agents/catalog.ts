import { createHash } from "node:crypto";
import {
	DEFAULT_PLAYBOOK_PROVIDER,
	getDefaultPlaybook,
	getPlaybook,
	getVaultProfile,
	type PlaybookTemplate,
	type ResolvedPlaybook,
	resolvePlaybookModel,
	resolveSeedPlaybook,
} from "@openagentpack/playbooks";
import {
	type AgentBuildInput,
	buildAgentDecl,
	collectConfigReferences,
	type ResolvedProjectConfig,
} from "@openagentpack/sdk";

// Default playbook when the caller omits agentId/playbookId. The route contract still uses
// `agentId`, but catalog ids now point to playbooks.
export const DEFAULT_AGENT_ID = "base";

export interface AgentValidationIssue {
	code: string;
	message: string;
}

export interface CompiledAgentRuntime {
	/** The source playbook template (id-keyed identity for session metadata). */
	agent: PlaybookTemplate;
	/** Remote agent name = config key = resolved playbook agent name. */
	agentId: string;
	agentConfigHash: string;
	config: ResolvedProjectConfig;
}

type MutableProjectConfig = Omit<ResolvedProjectConfig, "agents" | "skills"> & {
	agents?: Record<string, AgentConfig>;
	skills?: Record<string, SkillConfig>;
};

type AgentConfig = NonNullable<ResolvedProjectConfig["agents"]>[string];
type SkillConfig = NonNullable<ResolvedProjectConfig["skills"]>[string];

/** Resolve a playbook by id; null mirrors the former catalog lookup (→ 404 at the route). */
export function getSessionAgent(
	playbookId: string,
	provider: string = DEFAULT_PLAYBOOK_PROVIDER,
): PlaybookTemplate | null {
	return getPlaybook(resolveEffectivePlaybookId(playbookId, provider), provider) ?? null;
}

/**
 * Map a requested playbook id to the id that should actually be used. Unknown ids fall back to the
 * base playbook with a warning so stale bookmarks / deleted playbooks keep working instead of 404-ing.
 */
function resolveEffectivePlaybookId(requested: string, provider: string): string {
	if (getPlaybook(requested, provider)) return requested;
	const fallback = getDefaultPlaybook(provider);
	console.warn(`[catalog] 玩法「${requested}」不存在，回退到 base「${fallback?.id ?? "<none>"}」`);
	return fallback?.id ?? requested;
}

export function compileAgentRuntime(
	playbookId: string,
	baseConfig: ResolvedProjectConfig,
	modelOverride?: string,
): CompiledAgentRuntime {
	const provider = baseConfig.defaults?.provider ?? DEFAULT_PLAYBOOK_PROVIDER;
	const effectiveId = resolveEffectivePlaybookId(playbookId, provider);
	const playbook = getSessionAgent(effectiveId, provider);
	if (!playbook) {
		throw new AgentNotFoundError(playbookId);
	}

	const issues = validateAgent(effectiveId, baseConfig);
	if (issues.length > 0) {
		throw new AgentValidationError(effectiveId, issues);
	}

	const config = cloneConfig(baseConfig);
	const resolved = resolveSeedPlaybook(effectiveId, provider);
	const runtimeAgentId = resolved.agent.name;
	const built = buildAgentDecl(undefined, toAgentBuildInput(resolved, provider, baseConfig, modelOverride));
	// The agent declares environment and vault so syncAgentResources manages them
	// through the plan/apply engine — giving base resources state tracking, drift
	// detection, and the same content-hash identity as agent/skill resources.

	config.agents = {
		...(config.agents ?? {}),
		[runtimeAgentId]: built.agent,
	};
	if (Object.keys(built.customSkills).length > 0) {
		config.skills = {
			...(config.skills ?? {}),
			...built.customSkills,
		};
	}

	const refIssues = collectConfigReferences(config as ResolvedProjectConfig)
		.filter((d) => d.severity === "error")
		.map((d) => ({ code: d.code, message: d.message }));
	if (refIssues.length > 0) {
		throw new AgentValidationError(playbookId, refIssues);
	}

	const agentConfigHash = computeAgentConfigHash(config, runtimeAgentId);
	return { agent: playbook, agentId: runtimeAgentId, agentConfigHash, config: config as ResolvedProjectConfig };
}

export function validateAgent(playbookId: string, _config: ResolvedProjectConfig): AgentValidationIssue[] {
	const provider = _config.defaults?.provider ?? DEFAULT_PLAYBOOK_PROVIDER;
	const effectiveId = resolveEffectivePlaybookId(playbookId, provider);
	const playbook = getPlaybook(effectiveId, provider);
	if (!playbook) {
		return [{ code: "playbook.not_found", message: `Playbook '${playbookId}' was not found.` }];
	}

	const issues: AgentValidationIssue[] = [];
	let resolved: ResolvedPlaybook;
	try {
		resolved = resolveSeedPlaybook(effectiveId, provider);
	} catch (error) {
		return [{ code: "playbook.invalid", message: error instanceof Error ? error.message : String(error) }];
	}

	if (!resolved.agent.model) {
		issues.push({ code: "agent.model.missing", message: `Playbook '${playbookId}' has no model.` });
	}
	if (!resolved.agent.system.trim()) {
		issues.push({ code: "agent.instructions.missing", message: `Playbook '${playbookId}' has no instructions.` });
	}

	for (const skill of resolved.agent.skills) {
		if (!skill.skillId.trim()) {
			issues.push({ code: "agent.skill.invalid", message: `Playbook '${playbookId}' has a skill without an id.` });
		}
	}

	for (const server of resolved.agent.mcpServers) {
		if (!server.name.trim()) {
			issues.push({ code: "agent.mcp.invalid", message: `Playbook '${playbookId}' has an MCP server without a name.` });
		}
		if (server.type !== "official" && !server.url?.trim()) {
			issues.push({
				code: "agent.mcp.url_missing",
				message: `Playbook '${playbookId}' has non-official MCP server '${server.name}' without a URL.`,
			});
		}
	}

	return issues;
}

export function computeAgentConfigHash(config: ResolvedProjectConfig, agentId: string): string {
	return createHash("sha256").update(stableStringify({ agentId, config })).digest("hex").slice(0, 16);
}

function toAgentBuildInput(
	resolved: ResolvedPlaybook,
	provider: string,
	baseConfig: ResolvedProjectConfig,
	modelOverride?: string,
): AgentBuildInput {
	const model = resolvePlaybookModel(resolved, provider, modelOverride);
	// Resolve environment and vault names from the assembled config so the compiled
	// agent declares them. This lets syncAgentResources manage base resources
	// through the plan/apply engine, giving them state tracking and drift detection.
	// Invariant: buildRuntimeConfig produces exactly one environment (and at most one
	// vault for providers that need credentials). If this assumption breaks, the agent
	// would silently bind the wrong resource — fail fast instead.
	const envKeys = Object.keys(baseConfig.environments ?? {});
	if (envKeys.length !== 1) {
		throw new Error(
			`Expected exactly 1 environment in runtime config, got ${envKeys.length}. ` +
				`The agent compile path assumes a single base environment per provider.`,
		);
	}
	const environmentName = envKeys[0]!;
	const vaultProfile = getVaultProfile(provider);
	let vaultName: string | undefined;
	if (vaultProfile) {
		const vaultKeys = Object.keys(baseConfig.vaults ?? {});
		if (vaultKeys.length !== 1) {
			throw new Error(
				`Expected exactly 1 vault in runtime config for provider '${provider}', got ${vaultKeys.length}. ` +
					`The agent compile path assumes a single base vault per provider.`,
			);
		}
		vaultName = vaultKeys[0]!;
	}
	return {
		description: resolved.agent.description,
		model,
		instructions: resolved.agent.system,
		environment: environmentName,
		vault: vaultName,
		provider,
		builtinTools: resolved.agent.builtinTools,
		skills: resolved.agent.skills.map((skill) =>
			skill.type === "custom"
				? {
						// A custom skill is a managed skill: the SDK registers config.skills[name] from its
						// source URL and the deploy path uploads it. name is the dedupe key (archive manifest).
						kind: skill.type,
						name: skill.name ?? skill.skillId,
						source: skill.url,
					}
				: { kind: skill.type, code: skill.skillId, version: skill.version },
		),
		mcp: resolved.agent.mcpServers.map((server) => ({
			serverName: server.name,
			serverType: server.url ? "url" : "official",
			serverUrl: server.url,
			tools: [],
		})),
		metadata: resolved.agent.metadata,
	};
}

function cloneConfig(config: ResolvedProjectConfig): MutableProjectConfig {
	return JSON.parse(JSON.stringify(config)) as MutableProjectConfig;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export class AgentNotFoundError extends Error {
	readonly status = 404;

	constructor(readonly agentId: string) {
		super(`Playbook '${agentId}' was not found or is disabled.`);
		this.name = "AgentNotFoundError";
	}
}

export class AgentValidationError extends Error {
	readonly status = 400;

	constructor(
		readonly agentId: string,
		readonly issues: AgentValidationIssue[],
	) {
		super(issues.map((issue) => issue.message).join("; "));
		this.name = "AgentValidationError";
	}
}

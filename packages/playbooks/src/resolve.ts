import {
	DEFAULT_PLAYBOOK_APP_ID,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	PROVIDER_DEFAULTS,
} from "./metadata.ts";
import type {
	AgentSkillResource,
	McpResource,
	PlaybookBundle,
	PlaybookTemplate,
	ResolvedMcpServer,
	ResolvedPlaybook,
	ResolvedSkill,
} from "./types.ts";

/** The runtime agent name is identity-only: the `Agents/` prefix plus the template id. */
export function getPlaybookAgentName(_bundle: PlaybookBundle, playbookId: string): string {
	return `${PLAYBOOK_AGENT_NAME_PREFIX}${playbookId}`;
}

/**
 * Resolve the model id to create the agent with. Playbook templates author a bailian-native model,
 * so the target provider's default is substituted unless the caller overrides it for this run;
 * falls back to the template model when the provider has no registered default. Single source of
 * truth for both transports (Mode A catalog provisioning and Mode B console createAgent).
 */
export function resolvePlaybookModel(resolved: ResolvedPlaybook, provider: string, modelOverride?: string): string {
	return modelOverride ?? PROVIDER_DEFAULTS[provider]?.model ?? resolved.agent.model;
}

export function resolvePlaybookSkills(bundle: PlaybookBundle, playbookId: string): ResolvedSkill[] {
	const template = requirePlaybookTemplate(bundle, playbookId);
	return template.skills.map((skill) => toResolvedSkill(playbookId, skill));
}

export function resolvePlaybookMcpServers(bundle: PlaybookBundle, playbookId: string): ResolvedMcpServer[] {
	const template = requirePlaybookTemplate(bundle, playbookId);
	return template.mcpServers.map(toResolvedMcpServer);
}

export function resolvePlaybook(bundle: PlaybookBundle, playbookId: string): ResolvedPlaybook {
	const template = requirePlaybookTemplate(bundle, playbookId);
	const environmentProfile = bundle.infrastructure.environment;
	const vaultProfile = bundle.infrastructure.vault;
	const skills = resolvePlaybookSkills(bundle, playbookId);
	const mcpServers = resolvePlaybookMcpServers(bundle, playbookId);
	const metadata = {
		[PLAYBOOK_APP_METADATA_KEY]: DEFAULT_PLAYBOOK_APP_ID,
		[PLAYBOOK_METADATA_KEY]: template.id,
	};
	return {
		id: template.id,
		agent: {
			name: getPlaybookAgentName(bundle, playbookId),
			model: template.model.id,
			system: template.system,
			description: localizedDescription(template),
			builtinTools: template.builtinTools,
			mcpServers,
			skills,
			metadata,
		},
		resources: {
			environmentProfile,
			vaultProfile,
		},
		metadata,
	};
}

function requirePlaybookTemplate(bundle: PlaybookBundle, id: string): PlaybookTemplate {
	const template = bundle.playbookTemplates.find((item) => item.id === id);
	if (!template) throw new Error(`未知执行模板「${id}」`);
	return template;
}

function toResolvedSkill(playbookId: string, skill: AgentSkillResource): ResolvedSkill {
	// A custom skill's provider `code` is assigned at upload, so the template cannot hard-code it;
	// it must declare a `url` for provisioning to ensure-upload and resolve. Official skill ids are
	// stable provider codes, so no url is needed.
	if (skill.type === "custom" && !skill.url) {
		throw new Error(`玩法「${playbookId}」引用的自定义 skill「${skill.id}」缺少 url，无法解析为 provider code`);
	}
	return {
		skillId: skill.id,
		type: skill.type,
		version: skill.version,
		...(skill.name ? { name: skill.name } : {}),
		...(skill.url ? { url: skill.url } : {}),
	};
}

function toResolvedMcpServer(resource: McpResource): ResolvedMcpServer {
	return { type: resource.type, name: resource.name, ...(resource.url ? { url: resource.url } : {}) };
}

function localizedDescription(template: PlaybookTemplate): string {
	const names = template.displayName;
	if (!names) return template.id;
	return names.zh ?? names.en ?? Object.values(names)[0] ?? template.id;
}

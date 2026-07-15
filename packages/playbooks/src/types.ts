export type ResourceOrigin = "official" | "custom";

/** A locale-suffixed display value (e.g. `{ zh: "网页设计", en: "Web Designer" }`). */
export type LocalizedText = Record<string, string>;

export interface PlaybookBundle {
	/** The operator-authored source of truth for playbook templates. */
	playbookTemplates: PlaybookTemplate[];
	infrastructure: Infrastructure;
}

/**
 * A playbook template is a full, normalized Agent body synced from the operator console workspace.
 * The runtime agent name is derived as `${PLAYBOOK_AGENT_NAME_PREFIX}${id}` — there is no stored name.
 */
export interface PlaybookTemplate {
	id: string;
	displayName: LocalizedText;
	samplePrompt?: LocalizedText;
	/** Authoritative full system prompt; used verbatim (no composition). */
	system: string;
	model: { id: string; name?: string };
	builtinTools: string[];
	skills: AgentSkillResource[];
	mcpServers: McpResource[];
	/** Provider Agent version; carried for the identity stamp. Defaults to 1 when absent. */
	version?: number;
	/** Optional avatar image URL supplied by provider metadata. */
	imageUrl?: string;
}

export interface AgentSkillResource {
	id: string;
	type: ResourceOrigin;
	version?: string;
	/** Expected provider skill name (the dedupe key). For custom skills, equals the archive manifest name. */
	name?: string;
	/** Downloadable source for a custom skill, resolved to a provider `code` at provision time. */
	url?: string;
}

export interface McpResource {
	id: string;
	name: string;
	type: ResourceOrigin;
	url?: string;
}

export interface EnvironmentNetworking {
	type: "unrestricted" | "limited";
	allow_mcp_servers?: boolean;
	allow_package_managers?: boolean;
	allowed_hosts?: string[];
}

export interface EnvironmentPackages {
	npm?: string[];
	apt?: string[];
	pip?: string[];
}

export interface EnvironmentProfile {
	name: string;
	description?: string;
	config: {
		type: "cloud";
		networking?: EnvironmentNetworking;
		packages?: EnvironmentPackages;
	};
}

export interface VaultCredentialStructure {
	name: string;
	type: "environment_variable";
	secret_name: string;
	networking?: { type: "unrestricted" | "limited" };
}

export interface VaultProfile {
	name: string;
	display_name: string;
	credentials: VaultCredentialStructure[];
}

export interface Infrastructure {
	/** The cloud sandbox profile to provision. Every provider needs one. */
	environment: EnvironmentProfile;
	/**
	 * The credential vault profile to provision. Optional: bailian needs one (holding its own
	 * `DASHSCOPE_API_KEY` for the `bl` CLI); other providers currently run with no vault.
	 */
	vault?: VaultProfile;
}

export interface ResolvedSkill {
	skillId: string;
	type: ResourceOrigin;
	version?: string;
	/** Expected provider skill name; carried for custom skills so provisioning can dedupe by name. */
	name?: string;
	/** Custom skill source; present when the skill must be ensure-uploaded before attaching. */
	url?: string;
}

export interface ResolvedMcpServer {
	type: ResourceOrigin;
	name: string;
	url?: string;
}

export interface ResolvedPlaybookAgentSpec {
	name: string;
	model: string;
	system: string;
	description: string;
	builtinTools: string[];
	mcpServers: ResolvedMcpServer[];
	skills: ResolvedSkill[];
	metadata: Record<string, string>;
}

export interface ResolvedPlaybookResourceRequirements {
	/** The cloud sandbox profile; every provider defines one. */
	environmentProfile: EnvironmentProfile;
	/** Undefined for providers that need no credential vault. */
	vaultProfile?: VaultProfile;
}

export interface ResolvedPlaybook {
	id: string;
	agent: ResolvedPlaybookAgentSpec;
	resources: ResolvedPlaybookResourceRequirements;
	metadata: Record<string, string>;
}

/** A presentation card resolved from a playbook template for a given active locale. */
export interface PlaybookCard {
	id: string;
	title: string;
	prompt: string;
	imageUrl?: string;
	playbookTemplateId: string;
}

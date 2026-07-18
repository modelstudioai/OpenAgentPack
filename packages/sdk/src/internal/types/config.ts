export type ProviderName = string;

export interface ProjectConfig {
	version: string;
	providers: Record<string, unknown>;
	defaults?: DefaultsConfig;
	environments?: Record<string, EnvironmentDecl>;
	tunnels?: Record<string, TunnelDecl>;
	vaults?: Record<string, VaultDecl>;
	memory_stores?: Record<string, MemoryStoreDecl>;
	skills?: Record<string, SkillDecl>;
	files?: Record<string, FileDecl>;
	agents?: Record<string, AgentDecl>;
	deployments?: Record<string, DeploymentDecl>;
}

export interface DefaultsConfig {
	provider?: string;
}

// --- Environment ---

export interface EnvironmentDecl {
	name?: string;
	description?: string;
	provider?: ProviderName;
	/** Pre-existing provider environment id. When set, OpenCMA treats the environment as an external reference and will not create/update/delete it remotely. */
	environment_id?: string;
	config: EnvironmentConfig;
	metadata?: Record<string, string>;
}

export interface EnvironmentConfig {
	type: "cloud" | "self_hosted";
	networking?: NetworkingConfig;
	packages?: PackagesConfig;
}

export interface TunnelDecl {
	name?: string;
	description?: string;
	provider?: ProviderName;
	/** Pre-existing Qoder tunnel id (e.g. tnl_00xxxx). Tunnels are allocated by Qoder BYOC admin and referenced, not created. */
	tunnel_id: string;
	metadata?: Record<string, string>;
}

export interface NetworkingConfig {
	type: "unrestricted" | "limited";
	allow_mcp_servers?: boolean;
	allow_package_managers?: boolean;
	allowed_hosts?: string[];
}

export interface PackagesConfig {
	apt?: string[];
	pip?: string[];
	npm?: string[];
	cargo?: string[];
	gem?: string[];
	go?: string[];
}

// --- Vault ---

export interface VaultDecl {
	display_name: string;
	provider?: ProviderName;
	credentials: CredentialDecl[];
	metadata?: Record<string, string>;
}

export type CredentialType = "static_bearer" | "environment_variable";

export interface CredentialDecl {
	name: string;
	type: CredentialType;
	// static_bearer
	mcp_server_url?: string;
	access_token?: string;
	protocol?: "sse" | "streamable_http";
	// environment_variable
	secret_name?: string;
	secret_value?: string;
	networking?: { type: "unrestricted" | "limited" };
}

// --- Memory Store ---

export interface MemoryStoreDecl {
	description: string;
	provider?: ProviderName;
	entries?: MemoryEntryDecl[];
}

export interface MemoryEntryDecl {
	key: string;
	content: string;
}

// --- Skill ---

export interface SkillDecl {
	name?: string;
	source: string;
	description?: string;
	version?: string;
	origin?: "custom" | "official";
	provider?: ProviderName;
}

// --- File ---

export interface FileDecl {
	source: string;
	name?: string;
	purpose?: string;
	provider?: ProviderName;
}

// --- Model ---

export interface ModelWithSpeed {
	id: string;
	speed?: "standard" | "fast";
}

export type ModelSpec = string | ModelWithSpeed;

// --- Agent ---

export interface AgentDecl {
	name?: string;
	description?: string;
	model: string | Record<ProviderName, ModelSpec>;
	instructions: string;
	environment?: string;
	tunnel?: string;
	provider?: ProviderName;
	tools?: AgentToolsDecl;
	mcp_servers?: McpServerDecl[];
	skills?: AgentSkillDecl[];
	vault?: string;
	memory_stores?: string[];
	multiagent?: MultiagentDecl;
	metadata?: Record<string, string>;
}

export type AgentSkillDecl = string | AgentSkillRefDecl;

export interface AgentSkillRefDecl {
	type: "official" | "custom";
	skill_id: string;
	version?: string;
}

export interface AgentToolsDecl {
	builtin: string[];
	mcp?: AgentMcpToolkitDecl[];
	permissions?: Record<string, "allow" | "ask">;
}

export interface AgentMcpToolkitDecl {
	type: "mcp_toolkit";
	mcp_server_name: string;
	default_config?: { enabled: boolean };
	configs: Array<{ name: string; enabled: boolean }>;
}

export interface McpServerDecl {
	name: string;
	type?: "url" | "http" | "official";
	url?: string;
}

export interface MultiagentDecl {
	type: "coordinator";
	agents: string[];
}

// --- Deployment ---

export interface DeploymentDecl {
	agent: string;
	agent_version?: number;
	environment?: string;
	tunnel?: string;
	vaults?: string[];
	memory_stores?: string[];
	resources?: DeploymentResourceDecl[];
	initial_events: InitialEventDecl[];
	schedule?: ScheduleDecl;
	description?: string;
	provider?: ProviderName;
	metadata?: Record<string, string>;
}

export type DeploymentResourceDecl =
	| DeploymentFileResource
	| DeploymentMemoryStoreResource
	| DeploymentGithubRepoResource;

export interface DeploymentFileResource {
	type: "file";
	file_id?: string;
	source?: string;
	mount_path?: string;
}

export interface DeploymentMemoryStoreResource {
	type: "memory_store";
	memory_store: string;
	access?: "read_write" | "read_only";
	instructions?: string;
}

export interface DeploymentGithubRepoResource {
	type: "github_repository";
	url: string;
	checkout?: { branch?: string; commit?: string };
	mount_path?: string;
	authorization_token?: string;
}

export type InitialEventDecl = InitialUserMessage | InitialSystemMessage | InitialDefineOutcome;

export interface InitialUserMessage {
	type: "user.message";
	content: string;
}

export interface InitialSystemMessage {
	type: "system.message";
	content: string;
}

export interface InitialDefineOutcome {
	type: "user.define_outcome";
	description?: string;
	rubric?: string;
	rubric_file?: string;
	max_iterations?: number;
}

export interface ScheduleDecl {
	expression: string;
	timezone: string;
}

// --- Resolved Config ---

/**
 * A ProjectConfig where all file references (instructions, memory entries)
 * have been resolved to their inline content.
 */
export interface ResolvedProjectConfig extends ProjectConfig {
	_resolved: true;
}

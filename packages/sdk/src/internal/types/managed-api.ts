import type { CredentialNetworking } from "./config.ts";
import type { CloudAgent, CloudEnvironment, CloudVault } from "./dto.ts";
import type { ProviderFileInfo } from "./file.ts";
import type { ProviderSkillInfo } from "./skill-info.ts";

export interface CursorPage<T> {
	data: T[];
	has_more: boolean;
	next_page?: string;
}

export interface CursorListOptions {
	limit?: number;
	page?: string;
}

export interface AgentListOptions extends CursorListOptions {
	include_archived?: boolean;
}

export type AgentVersionListOptions = CursorListOptions;

export type AgentPage = CursorPage<CloudAgent>;

export interface EnvironmentListOptions extends CursorListOptions {
	include_archived?: boolean;
}

export type EnvironmentPage = CursorPage<CloudEnvironment>;

export interface VaultListOptions extends CursorListOptions {
	include_archived?: boolean;
}

export type VaultPage = CursorPage<CloudVault>;

/** Read-only remote policy; injection locations cannot be configured in declarations. */
export interface CredentialInjectionLocation {
	readonly header?: boolean;
	readonly body?: boolean;
}

export interface VaultCredentialInfo {
	id: string;
	display_name: string;
	auth_type: string;
	secret_name?: string;
	mcp_server_url?: string;
	networking_type?: string;
	networking?: CredentialNetworking;
	readonly injection_location?: CredentialInjectionLocation;
	metadata?: Record<string, string>;
}

export interface SkillListOptions extends CursorListOptions {
	source?: "custom" | "official";
}

export interface SkillVersionInfo {
	id?: string;
	skill_id: string;
	type: string;
	name?: string;
	description?: string;
	version: string;
	status?: string;
	created_at?: string;
	updated_at?: string;
	additional_properties?: Record<string, unknown>;
	attributes: Record<string, unknown>;
}

export type SkillVersionListOptions = CursorListOptions;

export type SkillVersionPage = CursorPage<SkillVersionInfo>;

export interface SkillDownloadInfo {
	skill_id: string;
	version: string;
	file_url: string;
}

export type SkillPage = CursorPage<ProviderSkillInfo>;

export interface FileListOptions extends CursorListOptions {
	scope_id?: string;
}

export type FilePage = CursorPage<ProviderFileInfo>;

export interface SessionUpdateInput {
	title?: string;
	metadata?: Record<string, string>;
}

/** Raw AgentStudio message/event input. Provider adapters preserve the wire shape. */
export type SessionEventInput = Record<string, unknown>;

export interface SessionEventSendResult {
	event_ids: string[];
	attributes: Record<string, unknown>;
}

export interface DeploymentRunInfo {
	id: string;
	deployment_id?: string;
	session_id?: string | null;
	status?: string;
	error?: { type?: string; message?: string };
	created_at?: string;
	updated_at?: string;
	attributes: Record<string, unknown>;
}

export type DeploymentRunPage = CursorPage<DeploymentRunInfo>;

export type ManagedAgentOperationAuth = "api_key" | "none";

export interface ManagedAgentOperationCapability {
	supported: boolean;
	auth: ManagedAgentOperationAuth | null;
	reason?: string;
}

export interface ManagedAgentProviderCapabilities {
	provider: string;
	operations: Record<string, ManagedAgentOperationCapability>;
}

export type { CloudAgent, CloudEnvironment, CloudVault, ProviderFileInfo, ProviderSkillInfo };

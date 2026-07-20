import type {
	AgentDecl,
	DeploymentDecl,
	EnvironmentDecl,
	MemoryStoreDecl,
	SkillDecl,
	VaultDecl,
} from "../types/config.ts";
import type { CloudAgent, CloudEnvironment, CloudVault } from "../types/dto.ts";
import type { ProviderFileInfo } from "../types/file.ts";
import type { ProviderSessionInfo, SessionBindings, SessionFilter, SessionListResult } from "../types/session.ts";
import type {
	EventListOptions,
	EventStreamOptions,
	ProviderSessionEvent,
	ProviderSessionEventList,
} from "../types/session-event.ts";
import type { SkillFile } from "../types/skill-file.ts";
import type { ProviderSkillInfo } from "../types/skill-info.ts";
import type { ResourceType } from "../types/state.ts";

export interface RemoteResource {
	id: string | null;
	type: string;
	version?: number;
}

export interface ModelInfo {
	id: string;
	display_name: string;
	source: string;
	is_enabled: boolean;
	is_new: boolean;
	price_factor?: number;
	efforts?: string[];
	default_effort?: string;
}

export type DriftSupport = "full" | "existence" | "unsupported";

export interface ComparableRemoteResource {
	id: string | null;
	type: string;
	version?: number;
	comparable: unknown;
	snapshot?: unknown;
}

/**
 * A remote resource reverse-mapped into a `agents.yaml` declaration, ready to be
 * serialized under the matching top-level group (e.g. `vaults.<name>`).
 * `name` is the yaml key; `decl` matches the corresponding zod schema shape.
 */
export interface ExportedResource {
	name: string;
	decl: Record<string, unknown>;
}

export interface ResolvedAgentRefs {
	skill_ids: Array<{ type: string; skill_id: string; version?: string }>;
	multiagent_agent_ids?: string[];
}

export interface ResolvedTemplateRefs extends ResolvedAgentRefs {
	environment_id: string;
	/** Qoder BYOC private-network route used by Forward Templates. */
	tunnel_id?: string;
	vault_ids: string[];
}

export interface ResolvedDeploymentRefs {
	agent_id: string;
	agent_version?: number;
	environment_id: string;
	/** Qoder BYOC tunnel id. Passed through only when the deployment targets Qoder BYOC. */
	tunnel_id?: string;
	vault_ids: string[];
	memory_store_ids: Record<string, string>;
}

export interface DeploymentContext {
	id: string | null;
	name: string;
	decl: DeploymentDecl;
	refs: ResolvedDeploymentRefs;
	basePath: string;
}

export interface DeploymentRunResult {
	run_id?: string;
	session_id: string | null;
	error?: { type: string; message: string };
}

export interface DeploymentInfo {
	id: string | null;
	status: string;
	paused_reason?: { type: string; error?: { type: string } };
	schedule?: { expression: string; timezone?: string };
	attributes?: Record<string, unknown>;
}

export interface ProviderAdapter {
	readonly name: string;
	/**
	 * Whether `sendSessionMessage` returns an event-id cursor the stream/poll can
	 * resume after. true → send-then-stream with `afterId`; false → connect-before-send.
	 */
	readonly eventResume: boolean;

	validate(): Promise<void>;
	/**
	 * Locate a remote resource. When `id` is provided, the resource is verified
	 * precisely via its detail endpoint (`GET /{endpoint}/{id}`), which avoids the
	 * ambiguity of name matching when names are not unique. Without `id`, falls
	 * back to listing and matching by `name` (used by conflict adoption).
	 */
	findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null>;
	// Raw cloud agent list (full remote objects, not local config). Optional: only
	// providers that can enumerate their remote agents implement it. `prefix` filters
	// by display-name prefix (e.g. "Agents/") server-side where supported.
	listAgents?(filter?: { prefix?: string; limit?: number }): Promise<CloudAgent[]>;
	// Raw cloud environment list (full remote objects). Optional: only providers that can
	// enumerate their remote environments implement it. Environments are a shared base
	// resource (sandbox), not tied to any playbook/agent.
	listEnvironments?(filter?: { limit?: number }): Promise<CloudEnvironment[]>;
	// Raw cloud vault list (full remote objects). Optional: only providers that can enumerate
	// their remote vaults implement it. Vaults are a shared credential store, not tied to a playbook.
	listVaults?(filter?: { limit?: number }): Promise<CloudVault[]>;
	getDriftSupport?(type: ResourceType): DriftSupport;
	readComparableResource?(
		type: ResourceType,
		id: string | null,
		name: string,
	): Promise<ComparableRemoteResource | null>;
	normalizeDesiredResource?(type: ResourceType, name: string, decl: unknown): unknown | null;

	/**
	 * Reverse-map remote resources of a given type into `agents.yaml` declarations
	 * (used by `agents sync`). Returns an empty array for unsupported types. Secret
	 * values that the provider does not return are emitted as `${ENV}` placeholders.
	 */
	exportResources?(type: ResourceType): Promise<ExportedResource[]>;

	createEnvironment(name: string, decl: EnvironmentDecl): Promise<RemoteResource>;
	updateEnvironment(id: string, name: string, decl: EnvironmentDecl): Promise<RemoteResource>;
	deleteEnvironment(id: string, cascade?: boolean): Promise<void>;

	createVault(name: string, decl: VaultDecl): Promise<RemoteResource>;
	deleteVault(id: string): Promise<void>;

	createSkill(name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource>;
	updateSkill(id: string, name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource>;
	deleteSkill(id: string): Promise<void>;

	createAgent(name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource>;
	updateAgent(id: string, name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource>;
	deleteAgent(id: string): Promise<void>;

	createTemplate?(name: string, decl: AgentDecl, refs: ResolvedTemplateRefs): Promise<RemoteResource>;
	updateTemplate?(id: string, name: string, decl: AgentDecl, refs: ResolvedTemplateRefs): Promise<RemoteResource>;
	/** Remove the template from desired state. Qoder implements this as a soft archive. */
	archiveTemplate?(id: string): Promise<void>;

	createMemoryStore?(name: string, decl: MemoryStoreDecl): Promise<RemoteResource>;
	deleteMemoryStore?(id: string): Promise<void>;

	createDeployment(
		name: string,
		decl: DeploymentDecl,
		refs: ResolvedDeploymentRefs,
		basePath: string,
	): Promise<RemoteResource>;
	updateDeployment(
		id: string,
		name: string,
		decl: DeploymentDecl,
		refs: ResolvedDeploymentRefs,
		basePath: string,
	): Promise<RemoteResource>;
	deleteDeployment(id: string): Promise<void>;
	runDeployment(ctx: DeploymentContext): Promise<DeploymentRunResult>;
	getDeployment(ctx: DeploymentContext): Promise<DeploymentInfo>;

	uploadFile(filePath: string, options?: { name?: string; purpose?: string }): Promise<ProviderFileInfo>;
	/** Upload from in-memory content (no filesystem), for server contexts that receive bytes directly (e.g. webui browser uploads). */
	uploadFileContent(
		content: Uint8Array,
		filename: string,
		options?: { mimeType?: string; purpose?: string },
	): Promise<ProviderFileInfo>;
	deleteFile(id: string): Promise<void>;
	/** Fetch a single file's metadata (incl. scan `status`); used to gate session binding on availability. */
	getFileInfo?(id: string): Promise<ProviderFileInfo>;
	/**
	 * Resolve a short-lived presigned download URL for a file (e.g. an agent-delivered artifact).
	 * Optional — only providers with a content/download endpoint implement it (qoder GET
	 * /files/{id}/content). Callers fetch it on demand so the URL never goes stale in the UI.
	 */
	getFileDownloadUrl?(id: string): Promise<{ url: string; expires_at?: string }>;
	/** List workspace user-uploaded files (newest first). Optional — only providers with a list API implement it. */
	listFiles?(): Promise<ProviderFileInfo[]>;

	/**
	 * List skills (newest first). `source` selects the catalog: "custom" (workspace-uploaded, the
	 * default) or "official" (the provider's built-in catalog). Optional — only providers with a
	 * list API implement it.
	 */
	listSkills?(source?: "custom" | "official"): Promise<ProviderSkillInfo[]>;
	/** Fetch a single skill's metadata (incl. scan `status`); used to poll create → active. */
	getSkillInfo?(id: string): Promise<ProviderSkillInfo>;
	/**
	 * Create a skill from an already-uploaded zip's file_id and return immediately with the
	 * initial (usually `checking`) status. NON-blocking — unlike `createSkill`, it does NOT wait
	 * for the security scan. The webui polls `getSkillInfo` until `active`.
	 */
	createSkillFromFileId?(fileId: string): Promise<ProviderSkillInfo>;

	createSession(bindings: SessionBindings): Promise<ProviderSessionInfo>;
	listSessions(filter?: SessionFilter): Promise<SessionListResult>;
	getSession(id: string): Promise<ProviderSessionInfo>;
	deleteSession(id: string): Promise<void>;

	sendSessionMessage(sessionId: string, message: string): Promise<string | undefined>;
	streamSessionEvents(sessionId: string, options?: EventStreamOptions): AsyncIterable<ProviderSessionEvent>;
	listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList>;

	listModels?(): Promise<ModelInfo[]>;

	/**
	 * Download all remote skills and return their extracted file content.
	 * Used by `agents sync` to materialize skill sources locally.
	 * Returns a map of skill name → extracted SkillFile[].
	 */
	downloadAllSkillFiles?(): Promise<Map<string, SkillFile[]>>;
}

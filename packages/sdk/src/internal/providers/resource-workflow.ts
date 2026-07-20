import type {
	AgentDecl,
	ChannelDecl,
	DeploymentDecl,
	EnvironmentDecl,
	IdentityDecl,
	MemoryStoreDecl,
	SkillDecl,
	VaultDecl,
} from "../types/config.ts";
import type { ProviderFileInfo } from "../types/file.ts";
import type { SkillFile } from "../types/skill-file.ts";
import type { ResourceType } from "../types/state.ts";
import type {
	ComparableRemoteResource,
	DeploymentContext,
	DeploymentInfo,
	DeploymentRunResult,
	DriftSupport,
	RemoteResource,
	ResolvedAgentRefs,
	ResolvedChannelRefs,
	ResolvedDeploymentRefs,
	ResolvedTemplateRefs,
} from "./interface.ts";

/**
 * The resource lifecycle seam: create/update/delete of declared resources plus
 * the lookup used for conflict adoption. The executor applies a plan exclusively
 * through this surface. The wide {@link import("./interface.ts").ProviderAdapter}
 * structurally satisfies it, so provider implementations stay put.
 */
export interface ResourceCrudAdapter {
	readonly name: string;

	findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null>;

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
	archiveTemplate?(id: string): Promise<void>;

	createIdentity?(name: string, decl: IdentityDecl): Promise<RemoteResource>;
	updateIdentity?(id: string, name: string, decl: IdentityDecl): Promise<RemoteResource>;
	deleteIdentity?(id: string): Promise<void>;

	createChannel?(name: string, decl: ChannelDecl, refs: ResolvedChannelRefs): Promise<RemoteResource>;
	updateChannel?(id: string, name: string, decl: ChannelDecl, refs: ResolvedChannelRefs): Promise<RemoteResource>;
	deleteChannel?(id: string): Promise<void>;

	// Optional: only providers whose capability matrix marks `memory_store` supported
	// implement these. The registry validates the matrix↔method match; unsupported
	// providers omit them entirely (no throw-stubs).
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

	uploadFile(filePath: string, options?: { name?: string; purpose?: string }): Promise<ProviderFileInfo>;
	deleteFile(id: string): Promise<void>;
}

/**
 * The deployment-execution seam: trigger a run and read deployment status. The
 * deployment runtime drives a configured deployment exclusively through this
 * surface. The wide {@link import("./interface.ts").ProviderAdapter} structurally
 * satisfies it; create/update/delete of deployments live in {@link ResourceCrudAdapter}.
 */
export interface DeploymentRunAdapter {
	runDeployment(ctx: DeploymentContext): Promise<DeploymentRunResult>;
	getDeployment(ctx: DeploymentContext): Promise<DeploymentInfo>;
}

/**
 * The drift-reading seam: capability-gated methods for comparing remote state to
 * desired config. All optional — only providers that support full drift implement
 * them. Capability checks live in {@link import("./drift-support.ts")}, not at call sites.
 */
export interface DriftReadAdapter {
	getDriftSupport?(type: ResourceType): DriftSupport;
	readComparableResource?(
		type: ResourceType,
		id: string | null,
		name: string,
	): Promise<ComparableRemoteResource | null>;
	normalizeDesiredResource?(type: ResourceType, name: string, decl: unknown): unknown | null;
}

export type ResourceKind =
	| "environment"
	| "vault"
	| "skill"
	| "agent"
	| "template"
	| "memory_store"
	| "mcp_server"
	| "multiagent"
	| "deployment"
	| "session"
	| "identity"
	| "channel";

export type SupportTier = "native" | "emulated" | "unsupported";

export interface CapabilityEntry {
	tier: SupportTier;
	reason: string;
	remediation?: string;
}

export type ProviderCapabilities = Record<ResourceKind, CapabilityEntry>;

/**
 * The lowest supported/unsupported decision, derived from the capability matrix.
 * A kind is supported when its tier is `native` or `emulated`. This is the single
 * base check shared by the planner/graph filter, config validation, and registry
 * facet validation — callers must not re-derive it from method presence.
 */
export function isSupported(caps: ProviderCapabilities | undefined, kind: ResourceKind): boolean {
	const tier = caps?.[kind]?.tier;
	return tier === "native" || tier === "emulated";
}

/**
 * The capability→facet contract: for each resource kind that carries dedicated
 * adapter methods, the methods a provider MUST implement when it declares that
 * kind supported (tier `native`/`emulated`). Kinds without dedicated methods
 * (`mcp_server`, `multiagent` — expressed through the agent decl) are omitted.
 * The registry validates a provider against this table at build time, so the
 * matrix is the single source of truth and unsupported kinds need no stub methods.
 *
 * Scope: this table gates only each kind's lifecycle/write + core-session methods.
 * Read/list methods (`listAgents`, `listEnvironments`, `listVaults`, `listSkills`,
 * `listModels`, `listFiles`, `exportResources`, drift reads) are deliberately NOT
 * gated here — they are an orthogonal, à-la-carte optional facet (a provider may
 * support a kind's lifecycle without offering a listing, e.g. claude/qoder create
 * agents but implement no `listAgents`) and are soft-degraded at their call sites.
 */
export const REQUIRED_METHODS_BY_KIND: Partial<Record<ResourceKind, readonly string[]>> = {
	environment: ["createEnvironment", "updateEnvironment", "deleteEnvironment"],
	vault: ["createVault", "deleteVault"],
	skill: ["createSkill", "updateSkill", "deleteSkill"],
	agent: ["createAgent", "updateAgent", "deleteAgent"],
	template: ["createTemplate", "updateTemplate", "archiveTemplate"],
	memory_store: [
		"createMemoryStore",
		"deleteMemoryStore",
		"listMemoryStores",
		"getMemoryStore",
		"updateMemoryStore",
		"createMemory",
		"listMemories",
		"getMemory",
		"updateMemory",
		"deleteMemory",
	],
	deployment: ["createDeployment", "updateDeployment", "deleteDeployment", "runDeployment", "getDeployment"],
	session: ["createSession", "listSessions", "getSession", "deleteSession", "sendSessionMessage"],
	identity: ["createIdentity", "updateIdentity", "deleteIdentity"],
	channel: ["createChannel", "updateChannel", "deleteChannel"],
};

// Public surface of @openagentpack/sdk.
// Everything re-exported here IS the public SDK API. Engine internals live under
// ./internal and are deliberately not exported — do not add internal-only symbols here.

export { UserError } from "./internal/errors.ts";

export type {
	BackendRuntimeInput,
	ProjectRuntimeContext,
} from "./internal/core/project-runtime.ts";
export {
	createProjectRuntime,
	readProjectRuntime,
	writeProjectRuntime,
} from "./internal/core/project-runtime.ts";

export type { ResolvedProjectConfig } from "./internal/types/config.ts";
export type { LoadedProjectConfig } from "./internal/parser/index.ts";
export {
	resolveProjectConfig,
	resolveProjectConfigFromObject,
} from "./internal/parser/index.ts";

export {
	decideDestructive,
	executePlannedProject,
	importResource,
	planProjectContext,
	syncProjectResourcesWithStateBackend,
} from "./internal/core/resource-runtime.ts";
export type {
	DestructivePolicy,
	ResourceActionResult,
	ResourceExecutionResult,
	ResourcePlanResult,
	ResourceRefreshResult,
	ResourceRuntimeOptions,
	ResourceSyncRun,
} from "./internal/core/resource-runtime.ts";

export {
	collectConfigReferences,
	validateProjectConfig,
} from "./internal/core/validate-config.ts";
export type { ValidateProjectConfigOptions } from "./internal/core/validate-config.ts";

export {
	resolveSyncProvider,
	syncProviderResourcesFromContext,
	syncProviderResourcesFromEnv,
} from "./internal/core/sync-runtime.ts";
export type {
	SecretPlaceholder,
	SyncProjectOptions,
	SyncProjectResult,
} from "./internal/core/sync-runtime.ts";

export { migrateConfig } from "./internal/core/migrate-runtime.ts";
export type {
	MigrateOptions,
	MigrateResult,
} from "./internal/core/migrate-runtime.ts";

export {
	getDeploymentDetailsForContext,
	getDeploymentRuntimeProviderForContext,
	listDeploymentsForContext,
	listRemoteDeploymentsForContext,
	pauseDeploymentForContext,
	runDeploymentForContext,
} from "./internal/core/deployment-runtime.ts";

export type { DeploymentListFilter, DeploymentListResult } from "./internal/providers/interface.ts";

export type { DestroyResourceResult } from "./internal/core/destroy-runtime.ts";
export {
	destroyPlannedProjectResources,
	planDestroyProjectContext,
} from "./internal/core/destroy-runtime.ts";

export {
	listProviderModelsForContext,
	listProviderNames,
} from "./internal/core/models-runtime.ts";
export {
	archiveMemoryStore,
	batchCreateMemories,
	createMemory,
	createMemoryStore,
	deleteMemoryStore,
	deleteMemory,
	getMemory,
	getMemoryProviderCapabilities,
	getMemoryStore,
	getMemoryVersion,
	listMemories,
	listMemoryStores,
	listMemoryVersions,
	redactMemoryVersion,
	updateMemory,
	updateMemoryStore,
} from "./internal/core/memory-runtime.ts";
export type {
	BatchCreateMemoryInput,
	BatchCreateMemoryResult,
	CreateMemoryInput,
	CreateMemoryStoreInput,
	MemoryInfo,
	MemoryListOptions,
	MemoryListItem,
	MemoryPrefixInfo,
	MemoryPage,
	MemoryProviderCapabilities,
	MemoryStoreInfo,
	MemoryStoreListOptions,
	MemoryVersionInfo,
	MemoryVersionListOptions,
	UpdateMemoryInput,
	UpdateMemoryStoreInput,
} from "./internal/types/memory.ts";

export type {
	AgentBuildInput,
	AgentMcpBuildInput,
	AgentSkillBuildInput,
} from "./internal/core/agent-builder.ts";
export { buildAgentDecl } from "./internal/core/agent-builder.ts";
export {
	archiveCloudAgent,
	createCloudEnvironment,
	createCloudVault,
	deleteCloudEnvironment,
	deleteCloudVault,
	getAgent,
	listAgentsWithReadiness,
	listCloudAgents,
	listCloudEnvironments,
	listCloudVaults,
	syncAgentResourcesWithStateBackend,
} from "./internal/core/agent-runtime.ts";

export type { CollectedSessionEvents } from "./internal/core/session-runtime.ts";
export {
	createSessionForAgent,
	createSkillFromFileId,
	deleteFile,
	deleteSession,
	deleteSkill,
	getFileDownloadUrl,
	getFileInfo,
	getSession,
	getSkillInfo,
	isTerminalSessionStatus,
	listSessionEvents,
	listFiles,
	listSessionSummaries,
	listSkills,
	sendSessionMessagePolling,
	sendSessionMessageStreaming,
	startSessionRun,
	startSessionRunPolling,
	streamSessionEvents,
	uploadFile,
} from "./internal/core/session-runtime.ts";
export { resolveSessionProvider } from "./internal/session/session-manager.ts";
export { prependFileHint, preparePromptForProvider, rewriteFileMentions } from "./internal/utils/sandbox-mount.ts";
export { resolveProviderConfigFromEnv } from "./internal/providers/registry.ts";
export {
	applyProviderConfigToEnv,
	areRuntimeCredentialsReady,
	bootstrapRuntimeCredentials,
	bootstrapRuntimeCredentialsSync,
	loadDotEnv,
	loadProviderConfigIntoEnv,
	loadProviderConfigIntoEnvSync,
	AGENTS_CONFIG_PROVIDERS,
	AGENTS_PROVIDER_FIELDS,
	providerConfigPath,
	resolveActiveProvider,
	type ProviderConfig,
	type ProviderConfigProvider,
} from "./internal/provider-config.ts";
export type { ProviderSessionInfo } from "./internal/types/session.ts";
export type { ProviderSessionEvent } from "./internal/types/session-event.ts";
export type { ProviderFileInfo } from "./internal/types/file.ts";
export type { ProviderSkillInfo } from "./internal/types/skill-info.ts";

export { parseStateAddress } from "./internal/core/state-runtime.ts";

export type { ResourceState } from "./internal/types/state.ts";
export type { IStateManager } from "./internal/state/state-manager.ts";
export { StateManager } from "./internal/state/state-manager.ts";
export { LocalFileStateBackend } from "./internal/state/local-file-state-backend.ts";
export type { StateScope } from "./internal/state/backend.ts";

export { extractSkillZipFiles } from "./internal/utils/normalize-skill-zip.ts";

export type {
	RuntimeFeedbackEvent,
	RuntimeFeedbackSink,
} from "./internal/types/runtime-feedback.ts";
export type { SkillFile } from "./internal/types/skill-file.ts";

// DTO + Zod schema contract (single source of truth) — kept whole.
export {
	ActionTypeSchema,
	AgentDefinitionSchema,
	AgentDriftSeveritySchema,
	AgentModelSchema,
	AgentReadinessSchema,
	AgentReadinessStatusSchema,
	AgentRecoveryActionSchema,
	AgentSkillRefSchema,
	AgentSyncResultSchema,
	AgentSyncRunSchema,
	AgentSyncStatusSchema,
	AgentWithReadinessSchema,
	CloudAgentSchema,
	CloudEnvironmentSchema,
	CloudVaultSchema,
	CreateSessionRequestSchema,
	CreateSessionResponseSchema,
	DiagnosticSchema,
	DiagnosticSeveritySchema,
	DriftKindSchema,
	GetSessionRequestSchema,
	KNOWN_SESSION_EVENT_TYPES,
	ListCloudAgentsResponseSchema,
	ListCloudEnvironmentsResponseSchema,
	ListSessionEventsRequestSchema,
	ListSessionEventsResponseSchema,
	ListSessionsRequestSchema,
	ListSessionsResponseSchema,
	PlannedActionSchema,
	PlanReadinessImpactSchema,
	ResourceAddressSchema,
	ResourceTypeSchema,
	SendEventRequestSchema,
	SendEventResponseSchema,
	SessionAgentSchema,
	SessionContentBlockSchema,
	SessionEventSchema,
	SessionEventTypeSchema,
	SessionSchema,
} from "./internal/types/dto.ts";
export type {
	ActionType,
	AgentDefinition,
	AgentDriftSeverity,
	AgentModel,
	AgentReadiness,
	AgentReadinessStatus,
	AgentRecoveryAction,
	AgentSkillRef,
	AgentSyncResult,
	AgentSyncRun,
	AgentSyncStatus,
	AgentWithReadiness,
	CloudAgent,
	CloudEnvironment,
	CloudVault,
	CreateSessionRequest,
	CreateSessionResponse,
	Diagnostic,
	DiagnosticSeverity,
	DriftKind,
	GetSessionRequest,
	KnownSessionEventType,
	ListCloudAgentsResponse,
	ListCloudEnvironmentsResponse,
	ListSessionEventsRequest,
	ListSessionEventsResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	PlannedAction,
	PlanReadinessImpact,
	ResourceAddress,
	ResourceType,
	SendEventRequest,
	SendEventResponse,
	Session,
	SessionAgent,
	SessionContentBlock,
	SessionEvent,
	SessionEventType,
	SessionEventTypeName,
} from "./internal/types/dto.ts";

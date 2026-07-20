import { z } from "zod";

export const ResourceTypeSchema = z.enum([
	"environment",
	"vault",
	"memory_store",
	"skill",
	"agent",
	"template",
	"deployment",
	"file",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const ResourceAddressSchema = z.object({
	type: ResourceTypeSchema,
	name: z.string(),
	provider: z.string(),
});
export type ResourceAddress = z.infer<typeof ResourceAddressSchema>;

export const DiagnosticSeveritySchema = z.enum(["error", "warning", "info"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DiagnosticSchema = z.object({
	severity: DiagnosticSeveritySchema,
	code: z.string(),
	message: z.string(),
	resource: ResourceAddressSchema.optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const ActionTypeSchema = z.enum(["create", "update", "delete", "no-op"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const DriftKindSchema = z.enum(["none", "local", "remote", "both"]);
export type DriftKind = z.infer<typeof DriftKindSchema>;

export const PlanReadinessImpactSchema = z.enum(["none", "non_blocking", "blocking"]);
export type PlanReadinessImpact = z.infer<typeof PlanReadinessImpactSchema>;

export const PlannedActionSchema = z.object({
	action: ActionTypeSchema,
	address: ResourceAddressSchema,
	reason: z.string(),
	driftKind: DriftKindSchema.optional(),
	readinessImpact: PlanReadinessImpactSchema.optional(),
	changedPaths: z.array(z.string()).optional(),
	before: z.record(z.string(), z.unknown()).optional(),
	after: z.record(z.string(), z.unknown()).optional(),
	dependencies: z.array(ResourceAddressSchema),
});
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const AgentReadinessStatusSchema = z.enum([
	"ready",
	"missing",
	"creating",
	"updating",
	"invalid",
	"drifted",
	"unavailable",
	"error",
]);
export type AgentReadinessStatus = z.infer<typeof AgentReadinessStatusSchema>;

export const AgentDriftSeveritySchema = z.enum(["blocking", "non_blocking"]);
export type AgentDriftSeverity = z.infer<typeof AgentDriftSeveritySchema>;

export const AgentSkillRefSchema = z.object({
	type: z.enum(["custom", "official"]),
	id: z.string(),
	version: z.string().optional(),
});
export type AgentSkillRef = z.infer<typeof AgentSkillRefSchema>;

export const AgentModelSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentDefinitionSchema = z.object({
	id: z.string(),
	agentName: z.string(),
	provider: z.string(),
	description: z.string().optional(),
	model: AgentModelSchema.optional(),
	environment: z.string().optional(),
	tools: z.unknown().optional(),
	skills: z.array(AgentSkillRefSchema),
	mcpServers: z.array(z.string()),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentReadinessSchema = z.object({
	status: AgentReadinessStatusSchema,
	agentId: z.string(),
	driftSeverity: AgentDriftSeveritySchema.optional(),
	diagnostics: z.array(DiagnosticSchema),
	missing: z.array(ResourceAddressSchema),
	plannedActions: z.array(PlannedActionSchema),
});
export type AgentReadiness = z.infer<typeof AgentReadinessSchema>;

export const AgentWithReadinessSchema = z.object({
	agent: AgentDefinitionSchema,
	readiness: AgentReadinessSchema,
});
export type AgentWithReadiness = z.infer<typeof AgentWithReadinessSchema>;

export const AgentRecoveryActionSchema = z.enum(["initialize", "repair", "refresh", "details"]);
export type AgentRecoveryAction = z.infer<typeof AgentRecoveryActionSchema>;

// A raw cloud agent as listed from the provider (Bailian `/agents` list) — the actual
// remote object, NOT a local config agent. This is the resource-center's source of truth:
// it surfaces same-name duplicates and identity-stamp drift (metadata.playbook vs agents.*) that
// the local config view cannot. Wire fields are snake_case. tools/skills/mcp_servers stay
// loose (`unknown`) because shapes differ by provider and the resource center only inspects
// metadata/name/timestamps for classification.
export const CloudAgentSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().nullish(),
	model: z.unknown().optional(),
	system: z.string().optional(),
	tools: z.unknown().optional(),
	skills: z.unknown().optional(),
	mcp_servers: z.unknown().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	version: z.number().optional(),
	type: z.string().optional(),
	workspace_id: z.string().optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
	archived_at: z.string().nullish(),
});
export type CloudAgent = z.infer<typeof CloudAgentSchema>;

export const ListCloudAgentsResponseSchema = z.object({
	agents: z.array(CloudAgentSchema),
});
export type ListCloudAgentsResponse = z.infer<typeof ListCloudAgentsResponseSchema>;

// Raw cloud environment — the sandbox (networking policy + preinstalled packages) that
// sessions/agents run inside. A shared, base resource not tied to any playbook. Wire fields are
// snake_case. `config` stays loose (`unknown`) since it's a discriminated union (cloud /
// self_hosted) the resource center only displays.
export const CloudEnvironmentSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().nullish(),
	config: z.unknown().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	scope: z.string().optional(),
	version: z.number().optional(),
	type: z.string().optional(),
	workspace_id: z.string().optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
	archived_at: z.string().nullish(),
});
export type CloudEnvironment = z.infer<typeof CloudEnvironmentSchema>;

export const ListCloudEnvironmentsResponseSchema = z.object({
	environments: z.array(CloudEnvironmentSchema),
});
export type ListCloudEnvironmentsResponse = z.infer<typeof ListCloudEnvironmentsResponseSchema>;

// Raw cloud vault — a credential store bound to a session via top-level `vault_ids`. A vault
// holds no inline credentials (those are separate objects); this DTO is the vault envelope the
// resource center / base-vault lookup needs. Wire fields are snake_case.
export const CloudVaultSchema = z.object({
	id: z.string(),
	display_name: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	type: z.string().optional(),
	created_at: z.string().nullish(),
	updated_at: z.string().nullish(),
	archived_at: z.string().nullish(),
});
export type CloudVault = z.infer<typeof CloudVaultSchema>;

export const ListCloudVaultsResponseSchema = z.object({
	vaults: z.array(CloudVaultSchema),
});
export type ListCloudVaultsResponse = z.infer<typeof ListCloudVaultsResponseSchema>;

export const SessionEventTypeSchema = z.enum([
	"status",
	"message",
	"thinking",
	"tool_use",
	"tool_result",
	"error",
	"unknown",
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const AgentSyncStatusSchema = z.enum(["completed", "blocked", "failed"]);
export type AgentSyncStatus = z.infer<typeof AgentSyncStatusSchema>;

export const AgentSyncResultSchema = z.object({
	action: PlannedActionSchema,
	status: z.enum(["success", "failed", "skipped"]),
	error: z.string().optional(),
});
export type AgentSyncResult = z.infer<typeof AgentSyncResultSchema>;

export const AgentSyncRunSchema = z.object({
	agentId: z.string(),
	provider: z.string().optional(),
	status: AgentSyncStatusSchema,
	actions: z.array(PlannedActionSchema),
	diagnostics: z.array(DiagnosticSchema),
	destructiveActions: z.array(PlannedActionSchema),
	results: z.array(AgentSyncResultSchema),
	error: z.string().optional(),
});
export type AgentSyncRun = z.infer<typeof AgentSyncRunSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Session-runtime contract — single source of truth. Wire fields are snake_case.
// ──────────────────────────────────────────────────────────────────────────

// The Agents session-event `type` values. The contract keeps the full set for
// hints/grouping but the schema accepts any string (see SessionEventSchema) so
// an unrecognized type is never dropped at the contract layer.
export const KNOWN_SESSION_EVENT_TYPES = [
	"message",
	"thread_message_sent",
	"thread_message_received",
	"reasoning",
	"function_call",
	"tool_call",
	"mcp_call",
	"tool_confirmation",
	"function_call_output",
	"tool_call_output",
	"mcp_call_output",
	"session_status",
	"session_updated",
	"thread_status",
	"thread_created",
	"model_request_start",
	"model_request_end",
	"define_outcome",
	"outcome_evaluation",
	"thread_context_compacted",
	"interrupt",
	"error",
] as const;
export type KnownSessionEventType = (typeof KNOWN_SESSION_EVENT_TYPES)[number];
// Open union: a known Agents type or any other string the backend may emit.
export type SessionEventTypeName = KnownSessionEventType | (string & {});

// A single content block carried by a session event. Unknown block types and
// extra fields are preserved (loose) so nothing is lost in transit.
export const SessionContentBlockSchema = z
	.object({
		type: z.string(),
		text: z.string().optional(),
		data: z.unknown().optional(),
	})
	.loose();
export type SessionContentBlock = z.infer<typeof SessionContentBlockSchema>;

// The unified session event. list and stream carry this same shape (no
// ISSEMessage/ISessionEvent split). `type` stays a raw string so the full Agents
// vocabulary survives; display grouping is a presentation concern layered on top.
export const SessionEventSchema = z.object({
	event_id: z.string().optional(),
	type: z.string(),
	role: z.string().optional(),
	created_at: z.string().optional(),
	content: z.array(SessionContentBlockSchema).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	is_error: z.boolean().nullish(),
	code: z.string().nullish(),
	message: z.string().nullish(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// The agent a session is bound to, as carried on the session DTO.
export const SessionAgentSchema = z
	.object({
		agent_id: z.string().optional(),
		name: z.string().optional(),
		version: z.number().optional(),
	})
	.loose();
export type SessionAgent = z.infer<typeof SessionAgentSchema>;

// The session DTO. `status` is the raw backend status (idle/running/terminated/…);
// callers derive any display status from it. Optional fields tolerate transports
// that omit them; the webui supplies presentation fallbacks.
export const SessionSchema = z.object({
	session_id: z.string(),
	status: z.string().optional(),
	title: z.string().optional(),
	agent: SessionAgentSchema.optional(),
	// The base sandbox a session runs inside. Optional: not every transport echoes it on
	// list. The resource center uses it to mark which environment the current playbook uses.
	environment_id: z.string().nullish(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ListSessionsRequestSchema = z.object({
	agent_id: z.string().optional(),
	session_id: z.string().optional(),
	created_at_gte: z.string().optional(),
	created_at_lte: z.string().optional(),
	include_archived: z.boolean().optional(),
	page_token: z.string().optional(),
	limit: z.number().int().optional(),
});
export type ListSessionsRequest = z.infer<typeof ListSessionsRequestSchema>;

export const ListSessionsResponseSchema = z.object({
	data: z.array(SessionSchema),
	next_page_token: z.string().nullish(),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const CreateSessionRequestSchema = z.object({
	agent_id: z.string(),
	title: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({
	session_id: z.string(),
	created_at: z.string().optional(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const GetSessionRequestSchema = z.object({
	session_id: z.string(),
});
export type GetSessionRequest = z.infer<typeof GetSessionRequestSchema>;

export const SendEventRequestSchema = z.object({
	session_id: z.string(),
	events: z.array(SessionEventSchema),
});
export type SendEventRequest = z.infer<typeof SendEventRequestSchema>;

export const SendEventResponseSchema = z.object({
	data: z.array(SessionEventSchema).optional(),
});
export type SendEventResponse = z.infer<typeof SendEventResponseSchema>;

export const ListSessionEventsRequestSchema = z.object({
	session_id: z.string(),
	limit: z.number().int().optional(),
	order: z.enum(["asc", "desc"]).optional(),
	page_token: z.string().optional(),
	after_id: z.string().optional(),
});
export type ListSessionEventsRequest = z.infer<typeof ListSessionEventsRequestSchema>;

export const ListSessionEventsResponseSchema = z.object({
	data: z.array(SessionEventSchema),
	next_page_token: z.string().nullish(),
});
export type ListSessionEventsResponse = z.infer<typeof ListSessionEventsResponseSchema>;

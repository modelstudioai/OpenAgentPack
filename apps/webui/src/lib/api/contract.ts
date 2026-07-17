import type { CloudAgent, CloudEnvironment, CloudVault, Session, SessionEvent } from "@openagentpack/sdk";

export type SessionList = { data: Session[]; next_page_token?: string | null };
export type SessionDetail = { session: Session; events: SessionEvent[]; events_next_page_token?: string | null };
export type SessionEventsPage = { events: SessionEvent[]; events_next_page_token?: string | null };
export type CloudAgentList = { agents: CloudAgent[] };
export type CloudEnvironmentList = { environments: CloudEnvironment[] };
export type CloudVaultList = { vaults: CloudVault[] };
// Provider-driven model option. An empty list from the transport means the provider has no dynamic
// model listing (e.g. bailian) — the UI then falls back to its bundled catalog.
export type ModelOption = { id: string; display_name: string; is_enabled?: boolean; is_new?: boolean };
export type ModelList = { models: ModelOption[] };
export type CreatedEnvironment = { id: string | null; type: string; version?: number };
export type CreatedVault = { id: string | null; type: string; version?: number };
// Provider scan status for an uploaded file. Binding a file to a session requires `available`;
// the provider rejects files still in `checking`. `rejected`/`type_rejected` are terminal failures.
export type FileStatus = "available" | "checking" | "rejected" | "type_rejected";

export type UploadedFile = {
	id: string;
	filename: string;
	mime_type: string;
	size_bytes: number;
	created_at?: string;
	status?: FileStatus;
	// Whether the file is bindable to a session. Set by the server via
	// @openagentpack/sdk/file-lifecycle — UI must not re-derive from raw provider wire.
	available?: boolean;
};

export type FileStatusInfo = { id: string; status?: FileStatus; available?: boolean };

// Skill scan lifecycle, mirroring the provider's SkillDTO status (0 checking / 1 active /
// 2 rejected / 100 deleted, normalized to strings). Drives the management UI's status badge.
export type SkillStatus = "checking" | "active" | "rejected" | "deleted";

// The neutral skill shape the REST transport returns. Maps the OpenAPI SkillDTO.
export type SkillSummary = {
	id: string;
	name: string;
	description?: string;
	source: "custom" | "official";
	status: SkillStatus;
	latest_version?: string;
	created_at?: string;
	updated_at?: string;
};

export type SkillStatusInfo = { id: string; status?: SkillStatus };

export type UploadSkillOptions = { body: { file: File } };
// uploadSkill lands the zip as a file pending audit ("pending"); the skill record is created in a
// second step once the file is available — orchestrated client-side via createSkillFromFile.
export type SkillUploadResult =
	| { kind: "created"; skill: SkillSummary }
	| { kind: "pending"; fileId: string; filename: string };
// Turn an available uploaded file into a skill record (second phase of uploadSkill).
export type CreateSkillFromFileOptions = { body: { fileId: string } };
// `source` selects the catalog: "custom" (workspace-uploaded, the default) or "official" (the
// provider's built-in catalog). The provider requires this be explicit to return official skills.
// Omitted → custom.
export type ListSkillsOptions = { query?: { source?: "custom" | "official" } };
export type DeleteSkillOptions = { path: { skillId: string } };
export type GetSkillStatusesOptions = { body: { skillIds: string[] } };

export type ApiError = {
	error: {
		message?: string;
	};
};

export type ApiResult<T> = {
	data?: T;
	error?: ApiError;
};

export type ListSessionsOptions = {
	query?: { limit?: number; agentId?: string; pageToken?: string };
};

export type CreateSessionOptions = {
	body: {
		agentId: string;
		prompt: string;
		// Required: every session runs inside a cloud sandbox environment.
		environmentId: string;
		vaultIds?: string[];
		title?: string;
		files?: { fileId: string; mountPath: string }[];
		// Model the session's agent should run. Switching the selector is local UI intent;
		// carrying a model here means createSession must apply it to the agent immediately
		// before the run (REST syncs compiled agent config).
		model?: string;
	};
};

export type GetSessionOptions = {
	path: { sessionId: string };
	query?: { agentId?: string };
};

export type ListSessionEventsOptions = {
	path: { sessionId: string };
	query?: { agentId?: string; pageToken?: string; limit?: number };
};

export type SendSessionMessageOptions = {
	path: { sessionId: string };
	body: { agentId?: string; message: string };
};

export type DeleteSessionOptions = {
	path: { sessionId: string };
	query?: { agentId?: string };
};

export type ListCloudAgentsOptions = {
	query?: { prefix?: string };
};

export type ArchiveCloudAgentOptions = {
	path: { agentId: string };
};

// Switch a playbook's model by updating its bound agent's config. agentId is the playbook SLUG
// (resolved to the real agent_ id inside the transport). A write-only op: persists the new
// model when the agent already exists, and is a no-op when it doesn't yet (the model then
// rides the next createSession). No read-back — the selector shows the playbook default until switched.
export type UpdateAgentOptions = {
	path: { agentId: string };
	body: { model: string };
};

// Warm a custom skill ahead of first click: resolve it to an `active` provider code (upload + the
// 3–5 min security scan) so the user's first click is a pure dedupe lookup, not a multi-minute wait.
// The unit is the distinct skill (name + downloadable url), not the playbook — a skill shared by several
// playbooks is warmed once. Idempotent: a skill of the same `name` already `active` returns immediately.
// Skill-only — warming creates NO agent (the fast agent create stays on the lazy first-click path).
// Best-effort: a failure leaves the playbook to the lazy first-click path. Runs warmSkillByUrl
// server-side.
export type WarmSkillOptions = {
	body: { name: string; url: string };
};

export type CreateEnvironmentOptions = {
	body: { name: string; description?: string; metadata?: Record<string, string> };
};

export type DeleteEnvironmentOptions = {
	path: { environmentId: string };
};

export type CreateVaultOptions = {
	// `key` is omitted in the base-resources gate — the server injects DASHSCOPE_API_KEY from its
	// env. So the contract makes it optional.
	body: { name: string; metadata?: Record<string, string>; key?: string };
};

export type DeleteVaultOptions = {
	path: { vaultId: string };
};

export type UploadFileOptions = {
	body: { file: File };
};

// Project isolation has no server-side support: neither wire carries file metadata/labels.
// So we encode ownership into the stored filename — every Agents upload is named
// `Agents__<original>`. The list filters by this prefix; display names and mount paths strip it,
// so the sandbox/user only ever see the clean original name. `limit` caps the single page fetched.
export type ListFilesOptions = {
	query?: never;
};

export type DeleteFileOptions = {
	path: { fileId: string };
};

export type GetFileStatusesOptions = {
	body: { fileIds: string[] };
};

// A short-lived presigned download URL for a file (typically an agent-delivered artifact).
// Fetched on demand per click so it never goes stale in the UI.
export type FileDownloadUrl = { url: string; expires_at?: string };
export type GetFileDownloadOptions = { path: { fileId: string } };

export const AGENTS_CONFIG_PROVIDERS = ["bailian", "qoder", "ark", "claude"] as const;
export type AgentsConfigProvider = (typeof AGENTS_CONFIG_PROVIDERS)[number];

export type AgentsProviderField = {
	key: string;
	label: string;
	secret: boolean;
};

export const AGENTS_PROVIDER_FIELDS: Record<AgentsConfigProvider, readonly AgentsProviderField[]> = {
	bailian: [
		{ key: "DASHSCOPE_API_KEY", label: "DASHSCOPE API Key", secret: true },
		{ key: "BAILIAN_WORKSPACE_ID", label: "Workspace ID", secret: false },
	],
	qoder: [{ key: "QODER_PAT", label: "QODER PAT", secret: true }],
	ark: [{ key: "ARK_API_KEY", label: "ARK API Key", secret: true }],
	claude: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", secret: true }],
};

export type AgentsConfig = {
	AGENTS_PROVIDER: AgentsConfigProvider;
	[key: string]: string;
};

/** GET /api/config — effective provider config: on-disk ~/.agents/config.json with process.env/.env fallback for all provider fields. */
export type AgentsConfigSnapshot = Partial<AgentsConfig>;

export type SaveAgentsConfigOptions = { body: AgentsConfig };

export type AgentsConfigReady = { ready: boolean; provider?: AgentsConfigProvider };

// ─────────────────────────────────────────────────────────────────────────────
// API surface — the REST transport contract. All calls converge on the
// snake_case @openagentpack/sdk data model. Some operations fan out to >1 call
// (noted with "+"). This single transport targets `/api/*` on the local server,
// which in turn drives the provider OpenAPI.
//
//   op                  REST (server)                    bailian OpenAPI (SDK provider)
//   ──                  ───────────────                   ──────────────────────────────
//   listSessions        GET  /api/sessions                GET  /sessions
//   createSession       POST /api/sessions  (1 call,      + POST /sessions/{id}/events
//                            create + first run;             (vault → top-level vault_ids;
//                            files → session resources;      files → resources:[{type:file,...}])
//                            vault → top-level vaultIds;
//                            model → agent override)
//   getSession          GET  /api/sessions/{id}           GET  /sessions/{id}
//                                                          + GET  /sessions/{id}/events
//   sendSessionMessage  POST /api/sessions/{id}/messages  POST /sessions/{id}/events
//   deleteSession       DELETE /api/sessions/{id}         DELETE /sessions/{id}
//   listAgents          GET  /api/cloud-agents             GET  /agents
//   listModels          GET  /api/models                   GET  /models (provider listing)
//   archiveAgent        POST /api/cloud-agents/{id}/archive POST /agents/{id}/archive
//   updateAgent         POST /api/cloud-agents/{slug}      POST /agents/{id} (sync-override of model)
//                            (sync-override of model)        — model write only; no-op when
//                                                              agent not yet provisioned
//   warmSkill           POST /api/skills/warm              (n/a — runs warmSkillByUrl: upload + scan,
//                            (→ warmSkillByUrl: dedupe          no agent create)
//                            by name, upload + scan)
//   listEnvironments    GET  /api/environments             GET  /environments
//   createEnvironment   POST /api/environments            POST /environments
//   deleteEnvironment   DELETE /api/environments/{id}     DELETE /environments/{id}
//   listVaults          GET  /api/vaults                  GET  /vaults
//   createVault         POST /api/vaults                  + POST /vaults/{id}/credentials
//   deleteVault         DELETE /api/vaults/{id}           DELETE /vaults/{id}
//   uploadFile          POST /api/files (multipart)       POST /files (multipart)
//   listFiles           GET  /api/files                    GET  /files (listAllPaged)
//   getFileStatuses     POST /api/files/status            GET  /files/{id} (per id)
//   getFileDownload     GET  /api/files/{id}/download      GET  /files/{id}/content
//                       (→ presigned URL; qoder only)      (presigned OSS attachment)
//   deleteFile          DELETE /api/files/{id}            DELETE /files/{id}
//   listSkills          GET  /api/skills?source=          GET  /skills?source=customer|official
//                            custom|official                  (listAllPaged; official is a
//                                                                separate page, custom is default)
//   uploadSkill         POST /api/skills/upload-file      — stops at the file (pending);
//                            (zip → file pending audit;       createSkillFromFileId does the
//                            returns {kind:pending})           create
//   createSkillFromFile POST /api/skills {fileId}         POST /skills (createSkillFromFileId)
//                            (2nd phase once file available)  — no file wait; gated server-side
//   getSkillStatuses    POST /api/skills/status           GET  /skills/{id} (per id)
//   deleteSkill         DELETE /api/skills/{id}           DELETE /skills/{id}
//   stream (separate)   GET  /api/sessions/{id}/stream    GET  /sessions/{id}/events/stream
//                            (SSE)                            (SSE)
// ─────────────────────────────────────────────────────────────────────────────
export interface ApiTransport {
	listSessions(options?: ListSessionsOptions): Promise<ApiResult<SessionList>>;
	createSession(options: CreateSessionOptions): Promise<ApiResult<SessionDetail>>;
	getSession(options: GetSessionOptions): Promise<ApiResult<SessionDetail>>;
	listSessionEvents(options: ListSessionEventsOptions): Promise<ApiResult<SessionEventsPage>>;
	sendSessionMessage(options: SendSessionMessageOptions): Promise<ApiResult<SessionDetail>>;
	deleteSession(options: DeleteSessionOptions): Promise<ApiResult<void>>;
	listAgents(options?: ListCloudAgentsOptions): Promise<ApiResult<CloudAgentList>>;
	// Lists the active provider's models. Returns the provider's dynamic listing; providers without
	// dynamic listing (bailian) return an empty list, so the UI falls back to its bundled catalog.
	listModels(): Promise<ApiResult<ModelList>>;
	archiveAgent(options: ArchiveCloudAgentOptions): Promise<ApiResult<void>>;
	updateAgent(options: UpdateAgentOptions): Promise<ApiResult<void>>;
	warmSkill(options: WarmSkillOptions): Promise<ApiResult<void>>;
	listEnvironments(): Promise<ApiResult<CloudEnvironmentList>>;
	createEnvironment(options: CreateEnvironmentOptions): Promise<ApiResult<CreatedEnvironment>>;
	deleteEnvironment(options: DeleteEnvironmentOptions): Promise<ApiResult<void>>;
	listVaults(): Promise<ApiResult<CloudVaultList>>;
	createVault(options: CreateVaultOptions): Promise<ApiResult<CreatedVault>>;
	deleteVault(options: DeleteVaultOptions): Promise<ApiResult<void>>;
	uploadFile(options: UploadFileOptions): Promise<ApiResult<UploadedFile>>;
	listFiles(options?: ListFilesOptions): Promise<ApiResult<{ files: UploadedFile[] }>>;
	getFileStatuses(options: GetFileStatusesOptions): Promise<ApiResult<{ files: FileStatusInfo[] }>>;
	// Resolve a presigned download URL for a file (agent-delivered artifact) via server →
	// qoder GET /files/{id}/content.
	getFileDownload(options: GetFileDownloadOptions): Promise<ApiResult<FileDownloadUrl>>;
	deleteFile(options: DeleteFileOptions): Promise<ApiResult<void>>;
	uploadSkill(options: UploadSkillOptions): Promise<ApiResult<SkillUploadResult>>;
	createSkillFromFile(options: CreateSkillFromFileOptions): Promise<ApiResult<SkillSummary>>;
	listSkills(options?: ListSkillsOptions): Promise<ApiResult<{ skills: SkillSummary[] }>>;
	getSkillStatuses(options: GetSkillStatusesOptions): Promise<ApiResult<{ skills: SkillStatusInfo[] }>>;
	deleteSkill(options: DeleteSkillOptions): Promise<ApiResult<void>>;
	getConfig(): Promise<ApiResult<AgentsConfigSnapshot>>;
	getConfigReady(): Promise<ApiResult<AgentsConfigReady>>;
	saveConfig(options: SaveAgentsConfigOptions): Promise<ApiResult<AgentsConfig>>;
}

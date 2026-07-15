import type {
	AgentsConfig,
	AgentsConfigReady,
	AgentsConfigSnapshot,
	ApiResult,
	ArchiveCloudAgentOptions,
	CloudAgentList,
	CloudEnvironmentList,
	CloudVaultList,
	CreatedEnvironment,
	CreatedVault,
	CreateEnvironmentOptions,
	CreateSessionOptions,
	CreateSkillFromFileOptions,
	CreateVaultOptions,
	DeleteEnvironmentOptions,
	DeleteFileOptions,
	DeleteSessionOptions,
	DeleteSkillOptions,
	DeleteVaultOptions,
	FileDownloadUrl,
	FileStatusInfo,
	GetFileDownloadOptions,
	GetFileStatusesOptions,
	GetSessionOptions,
	GetSkillStatusesOptions,
	ListCloudAgentsOptions,
	ListFilesOptions,
	ListSessionEventsOptions,
	ListSessionsOptions,
	ListSkillsOptions,
	ModelList,
	SaveAgentsConfigOptions,
	SendSessionMessageOptions,
	SessionDetail,
	SessionEventsPage,
	SessionList,
	SkillStatusInfo,
	SkillSummary,
	SkillUploadResult,
	UploadedFile,
	UploadFileOptions,
	UploadSkillOptions,
	WarmSkillOptions,
} from "./contract";
import { restTransport } from "./transports/rest";

export type {
	ApiError,
	ApiResult,
	CloudAgentList,
	CloudEnvironmentList,
	CloudVaultList,
	FileStatusInfo,
	ModelList,
	ModelOption,
	SessionDetail,
	SessionEventsPage,
	SessionList,
	SkillStatusInfo,
	SkillSummary,
	SkillUploadResult,
	UploadedFile,
} from "./contract";

export function getApiSessions(options: ListSessionsOptions = {}): Promise<ApiResult<SessionList>> {
	return restTransport.listSessions(options);
}

export function createApiSession(options: CreateSessionOptions): Promise<ApiResult<SessionDetail>> {
	return restTransport.createSession(options);
}

export function getApiSession(options: GetSessionOptions): Promise<ApiResult<SessionDetail>> {
	return restTransport.getSession(options);
}

export function listApiSessionEvents(options: ListSessionEventsOptions): Promise<ApiResult<SessionEventsPage>> {
	return restTransport.listSessionEvents(options);
}

export function sendApiSessionMessage(options: SendSessionMessageOptions): Promise<ApiResult<SessionDetail>> {
	return restTransport.sendSessionMessage(options);
}

export function deleteApiSession(options: DeleteSessionOptions): Promise<ApiResult<void>> {
	return restTransport.deleteSession(options);
}

export function getApiCloudAgents(options: ListCloudAgentsOptions = {}): Promise<ApiResult<CloudAgentList>> {
	return restTransport.listAgents(options);
}

export function getApiModels(): Promise<ApiResult<ModelList>> {
	return restTransport.listModels();
}

export function archiveApiCloudAgent(options: ArchiveCloudAgentOptions): Promise<ApiResult<void>> {
	return restTransport.archiveAgent(options);
}

export function warmApiSkill(options: WarmSkillOptions): Promise<ApiResult<void>> {
	return restTransport.warmSkill(options);
}

export function getApiEnvironments(): Promise<ApiResult<CloudEnvironmentList>> {
	return restTransport.listEnvironments();
}

export function createApiEnvironment(options: CreateEnvironmentOptions): Promise<ApiResult<CreatedEnvironment>> {
	return restTransport.createEnvironment(options);
}

export function deleteApiEnvironment(options: DeleteEnvironmentOptions): Promise<ApiResult<void>> {
	return restTransport.deleteEnvironment(options);
}

export function getApiVaults(): Promise<ApiResult<CloudVaultList>> {
	return restTransport.listVaults();
}

export function createApiVault(options: CreateVaultOptions): Promise<ApiResult<CreatedVault>> {
	return restTransport.createVault(options);
}

export function deleteApiVault(options: DeleteVaultOptions): Promise<ApiResult<void>> {
	return restTransport.deleteVault(options);
}

export function uploadApiFile(options: UploadFileOptions): Promise<ApiResult<UploadedFile>> {
	return restTransport.uploadFile(options);
}

export function listApiFiles(options: ListFilesOptions = {}): Promise<ApiResult<{ files: UploadedFile[] }>> {
	return restTransport.listFiles(options);
}

export function getApiFileStatuses(options: GetFileStatusesOptions): Promise<ApiResult<{ files: FileStatusInfo[] }>> {
	return restTransport.getFileStatuses(options);
}

export function getApiFileDownload(options: GetFileDownloadOptions): Promise<ApiResult<FileDownloadUrl>> {
	return restTransport.getFileDownload(options);
}

export function deleteApiFile(options: DeleteFileOptions): Promise<ApiResult<void>> {
	return restTransport.deleteFile(options);
}

export function uploadApiSkill(options: UploadSkillOptions): Promise<ApiResult<SkillUploadResult>> {
	return restTransport.uploadSkill(options);
}

export function createApiSkillFromFile(options: CreateSkillFromFileOptions): Promise<ApiResult<SkillSummary>> {
	return restTransport.createSkillFromFile(options);
}

export function listApiSkills(options: ListSkillsOptions = {}): Promise<ApiResult<{ skills: SkillSummary[] }>> {
	return restTransport.listSkills(options);
}

export function getApiSkillStatuses(
	options: GetSkillStatusesOptions,
): Promise<ApiResult<{ skills: SkillStatusInfo[] }>> {
	return restTransport.getSkillStatuses(options);
}

export function deleteApiSkill(options: DeleteSkillOptions): Promise<ApiResult<void>> {
	return restTransport.deleteSkill(options);
}

export function getApiConfig(): Promise<ApiResult<AgentsConfigSnapshot>> {
	return restTransport.getConfig();
}

export function getApiConfigReady(): Promise<ApiResult<AgentsConfigReady>> {
	return restTransport.getConfigReady();
}

export function saveApiConfig(options: SaveAgentsConfigOptions): Promise<ApiResult<AgentsConfig>> {
	return restTransport.saveConfig(options);
}

import { UserError } from "../errors.ts";
import { ApiError } from "../providers/base-client.ts";
import type {
	DeploymentInfo,
	DeploymentListFilter,
	DeploymentListResult,
	DeploymentRunResult,
	ProviderAdapter,
} from "../providers/interface.ts";
import { resolveFetch } from "../transport.ts";
import type {
	AgentListOptions,
	AgentPage,
	AgentVersionListOptions,
	DeploymentRunInfo,
	DeploymentRunPage,
	EnvironmentListOptions,
	EnvironmentPage,
	FileListOptions,
	FilePage,
	ManagedAgentOperationCapability,
	ManagedAgentProviderCapabilities,
	SessionEventInput,
	SessionEventSendResult,
	SessionUpdateInput,
	SkillDownloadInfo,
	SkillListOptions,
	SkillPage,
	SkillVersionInfo,
	SkillVersionListOptions,
	SkillVersionPage,
	VaultListOptions,
	VaultPage,
} from "../types/managed-api.ts";
import type { ProviderSessionInfo } from "../types/session.ts";
import type { ProviderSkillInfo } from "../types/skill-info.ts";
import type { ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider } from "./project-runtime.ts";

export interface ManagedApiTarget {
	provider?: string;
}

function resolveAdapter(ctx: ProjectRuntimeContext, provider?: string): ProviderAdapter {
	if (provider) return getRuntimeProvider(ctx, provider);
	const configured = Array.from(ctx.providers.keys());
	if (configured.length === 1) return getRuntimeProvider(ctx, configured[0]!);
	throw new UserError("Multiple providers configured. Use --provider to specify one.");
}

function requiredMethod<T>(value: T | undefined, provider: string, operation: string): T {
	if (value) return value;
	throw new UserError(`Provider '${provider}' does not support ${operation}.`);
}

export async function listRemoteAgents(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & AgentListOptions = {},
): Promise<AgentPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listAgentResources, adapter.name, "agent listing");
	return method.call(adapter, options);
}

export async function getRemoteAgent(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget & { version?: number } = {},
) {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getRemoteAgent, adapter.name, "agent lookup");
	return method.call(adapter, id, options.version);
}

export async function listRemoteAgentVersions(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget & AgentVersionListOptions = {},
): Promise<AgentPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listAgentVersions, adapter.name, "agent version listing");
	return method.call(adapter, id, options);
}

export async function listRemoteEnvironments(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & EnvironmentListOptions = {},
): Promise<EnvironmentPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listEnvironmentResources, adapter.name, "environment listing");
	return method.call(adapter, options);
}

export async function getRemoteEnvironment(ctx: ProjectRuntimeContext, id: string, options: ManagedApiTarget = {}) {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getRemoteEnvironment, adapter.name, "environment lookup");
	return method.call(adapter, id);
}

export async function listRemoteVaults(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & VaultListOptions = {},
): Promise<VaultPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listVaultResources, adapter.name, "vault listing");
	return method.call(adapter, options);
}

export async function getRemoteVault(ctx: ProjectRuntimeContext, id: string, options: ManagedApiTarget = {}) {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getRemoteVault, adapter.name, "vault lookup");
	return method.call(adapter, id);
}

export async function listRemoteSkills(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & SkillListOptions = {},
): Promise<SkillPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listSkillResources, adapter.name, "skill listing");
	return method.call(adapter, options);
}

export async function getRemoteSkill(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget = {},
): Promise<ProviderSkillInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getSkillInfo, adapter.name, "skill lookup");
	return method.call(adapter, id);
}

export async function listRemoteSkillVersions(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget & SkillVersionListOptions = {},
): Promise<SkillVersionPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listSkillVersions, adapter.name, "skill version listing");
	return method.call(adapter, id, options);
}

export async function getRemoteSkillVersion(
	ctx: ProjectRuntimeContext,
	id: string,
	version: string,
	options: ManagedApiTarget = {},
): Promise<SkillVersionInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getSkillVersion, adapter.name, "skill version lookup");
	return method.call(adapter, id, version);
}

export async function getRemoteSkillDownloadInfo(
	ctx: ProjectRuntimeContext,
	id: string,
	version: string,
	options: ManagedApiTarget = {},
): Promise<SkillDownloadInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getSkillDownloadInfo, adapter.name, "skill version download");
	return method.call(adapter, id, version);
}

export async function downloadRemoteSkill(
	ctx: ProjectRuntimeContext,
	id: string,
	version: string,
	options: ManagedApiTarget = {},
): Promise<Uint8Array> {
	const info = await getRemoteSkillDownloadInfo(ctx, id, version, options);
	const response = await resolveFetch()(info.file_url, { method: "GET" });
	if (!response.ok) {
		throw new ApiError(response.status, await response.text(), "Skill download failed");
	}
	return new Uint8Array(await response.arrayBuffer());
}

export async function listRemoteFiles(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & FileListOptions = {},
): Promise<FilePage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listFileResources, adapter.name, "file listing");
	return method.call(adapter, options);
}

export async function downloadRemoteFile(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget = {},
): Promise<Uint8Array> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.downloadFileContent, adapter.name, "file content download");
	return method.call(adapter, id);
}

export async function updateRemoteSession(
	ctx: ProjectRuntimeContext,
	id: string,
	input: SessionUpdateInput,
	options: ManagedApiTarget = {},
): Promise<ProviderSessionInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.updateSession, adapter.name, "session update");
	return method.call(adapter, id, input);
}

export async function archiveRemoteSession(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget = {},
): Promise<ProviderSessionInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.archiveSession, adapter.name, "session archive");
	return method.call(adapter, id);
}

export async function sendRemoteSessionEvents(
	ctx: ProjectRuntimeContext,
	id: string,
	events: SessionEventInput[],
	options: ManagedApiTarget = {},
): Promise<SessionEventSendResult> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.sendSessionEvents, adapter.name, "generic session event sending");
	return method.call(adapter, id, events);
}

export async function listRemoteDeployments(
	ctx: ProjectRuntimeContext,
	options: ManagedApiTarget & DeploymentListFilter = {},
): Promise<DeploymentListResult> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listDeployments, adapter.name, "deployment listing");
	return method.call(adapter, options);
}

export async function getRemoteDeployment(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget = {},
): Promise<DeploymentInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getDeploymentById, adapter.name, "deployment lookup");
	return method.call(adapter, id);
}

export async function runRemoteDeployment(
	ctx: ProjectRuntimeContext,
	id: string,
	options: ManagedApiTarget = {},
): Promise<DeploymentRunResult> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.runDeploymentById, adapter.name, "deployment run");
	return method.call(adapter, id);
}

export async function setRemoteDeploymentPaused(
	ctx: ProjectRuntimeContext,
	id: string,
	paused: boolean,
	options: ManagedApiTarget = {},
): Promise<DeploymentInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = paused ? adapter.pauseDeploymentById : adapter.unpauseDeploymentById;
	return requiredMethod(method, adapter.name, `${paused ? "pausing" : "unpausing"} deployments`).call(adapter, id);
}

export async function listRemoteDeploymentRuns(
	ctx: ProjectRuntimeContext,
	deploymentId: string,
	options: ManagedApiTarget & { limit?: number; page?: string } = {},
): Promise<DeploymentRunPage> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.listDeploymentRuns, adapter.name, "deployment run listing");
	return method.call(adapter, deploymentId, options);
}

export async function getRemoteDeploymentRun(
	ctx: ProjectRuntimeContext,
	runId: string,
	options: ManagedApiTarget = {},
): Promise<DeploymentRunInfo> {
	const adapter = resolveAdapter(ctx, options.provider);
	const method = requiredMethod(adapter.getDeploymentRun, adapter.name, "deployment run lookup");
	return method.call(adapter, runId);
}

const API_KEY: ManagedAgentOperationCapability = { supported: true, auth: "api_key" };
const CLIENT_SEARCH: ManagedAgentOperationCapability = {
	supported: true,
	auth: "api_key",
	reason: "Client-side filtering over the corresponding list API.",
};
const UNSUPPORTED_MODEL: ManagedAgentOperationCapability = {
	supported: false,
	auth: null,
	reason: "The public Managed Agents API does not expose a model catalog endpoint.",
};
const UNSUPPORTED_THREAD: ManagedAgentOperationCapability = {
	supported: false,
	auth: null,
	reason:
		"Managed Agents exposes child-thread ids and lifecycle events through Session Events, but no independent Thread resource API.",
};
const UNSUPPORTED_OAUTH: ManagedAgentOperationCapability = {
	supported: false,
	auth: null,
	reason: "The public Managed Agents data plane does not expose MCP OAuth login.",
};

const BAILIAN_OPERATIONS: Record<string, ManagedAgentOperationCapability> = {
	"agent.create": { ...API_KEY, reason: "YAML declaration plus scoped create-only apply." },
	"agent.list": API_KEY,
	"agent.get": API_KEY,
	"agent.search": CLIENT_SEARCH,
	"agent.versions": API_KEY,
	"environment.create": { ...API_KEY, reason: "YAML declaration plus scoped create-only apply." },
	"environment.list": API_KEY,
	"environment.get": API_KEY,
	"environment.search": CLIENT_SEARCH,
	"skill.create": { ...API_KEY, reason: "YAML declaration plus scoped create-only apply." },
	"skill.list": API_KEY,
	"skill.get": API_KEY,
	"skill.search": CLIENT_SEARCH,
	"skill.versions": API_KEY,
	"skill.download": API_KEY,
	"vault.create": { ...API_KEY, reason: "YAML declaration plus scoped create-only apply." },
	"vault.credential.create": { ...API_KEY, reason: "YAML declaration plus scoped Vault transaction." },
	"vault.list": API_KEY,
	"vault.get": API_KEY,
	"vault.search": CLIENT_SEARCH,
	"deployment.create": { ...API_KEY, reason: "YAML declaration plus scoped create-only apply." },
	"deployment.list": API_KEY,
	"deployment.get": API_KEY,
	"deployment.search": { ...API_KEY, reason: "Maps to the server-side keyword parameter." },
	"deployment.runs.list": API_KEY,
	"deployment.runs.get": API_KEY,
	"deployment.run": API_KEY,
	"deployment.pause": API_KEY,
	"deployment.unpause": API_KEY,
	"session.create": API_KEY,
	"session.list": API_KEY,
	"session.get": API_KEY,
	"session.search": CLIENT_SEARCH,
	"session.update": API_KEY,
	"session.archive": API_KEY,
	"session.delete": API_KEY,
	"session.run": { ...API_KEY, reason: "Client composition of session create and event send/stream." },
	"session.event.send": API_KEY,
	"session.event.list": API_KEY,
	"session.event.stream": API_KEY,
	"session.debug": { ...API_KEY, reason: "Client-side aggregation of supported read APIs." },
	"session.export": { ...API_KEY, reason: "Client-side export of supported read APIs." },
	"file.upload": API_KEY,
	"file.list": API_KEY,
	"file.get": API_KEY,
	"file.search": CLIENT_SEARCH,
	"file.download": API_KEY,
	"file.delete": API_KEY,
	"model.list": UNSUPPORTED_MODEL,
	"model.search": UNSUPPORTED_MODEL,
	"session_thread.list": UNSUPPORTED_THREAD,
	"session_thread.get": UNSUPPORTED_THREAD,
	"session_thread.archive": UNSUPPORTED_THREAD,
	"session_thread.events": UNSUPPORTED_THREAD,
	"mcp.oauth_login": UNSUPPORTED_OAUTH,
};

export function getManagedAgentProviderCapabilities(provider: string): ManagedAgentProviderCapabilities {
	if (provider === "bailian") {
		return { provider, operations: { ...BAILIAN_OPERATIONS } };
	}
	return {
		provider,
		operations: {
			"managed_agent.api": {
				supported: false,
				auth: null,
				reason: "The operation-level API command surface is currently implemented for Bailian only.",
			},
		},
	};
}

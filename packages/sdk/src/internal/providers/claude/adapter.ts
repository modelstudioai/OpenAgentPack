import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	DeploymentDecl,
	EnvironmentDecl,
	MemoryStoreDecl,
	SkillDecl,
	VaultDecl,
} from "../../types/config.ts";
import type { CloudAgent, CloudEnvironment, CloudVault } from "../../types/dto.ts";
import type { ProviderFileInfo } from "../../types/file.ts";
import type {
	CreateMemoryInput,
	MemoryListOptions,
	MemoryStoreListOptions,
	MemoryVersionListOptions,
	UpdateMemoryInput,
	UpdateMemoryStoreInput,
} from "../../types/memory.ts";
import type { ProviderSessionInfo, SessionBindings, SessionFilter, SessionListResult } from "../../types/session.ts";
import type {
	EventListOptions,
	EventStreamOptions,
	ProviderSessionEvent,
	ProviderSessionEventList,
} from "../../types/session-event.ts";
import type { SkillFile } from "../../types/skill-file.ts";
import type { ProviderSkillInfo } from "../../types/skill-info.ts";
import type { ResourceType } from "../../types/state.ts";
import { extractSkillZipFiles } from "../../utils/normalize-skill-zip.ts";
import { skillNameFromFiles } from "../../utils/skill-manifest.ts";
import { toRemoteResource } from "../base-client.ts";
import type {
	DeploymentContext,
	DeploymentInfo,
	DeploymentRunResult,
	ExportedResource,
	ModelInfo,
	ProviderAdapter,
	RemoteResource,
	ResolvedAgentRefs,
	ResolvedDeploymentRefs,
} from "../interface.ts";
import { ProviderMemoryApi } from "../memory-api.ts";
import { extractCreatedEventId, listSessionEventsPaged } from "../session-event-response.ts";
import {
	buildSessionInfo,
	exportRemoteResources,
	locateRemote,
	notArchived,
	toCloudAgent,
	toCloudEnvironment,
	toCloudVault,
	toRestFileInfo,
	toRestSkillInfo,
} from "../shared.ts";
import { resourceNameFromMetadata } from "../sync-mapping.ts";
import { ClaudeClient } from "./client.ts";
import {
	agentToDecl,
	envToDecl,
	fileToDecl,
	mapAgent,
	mapDeployment,
	mapEnvironment,
	mapSendMessage,
	mapSession,
	skillToDecl,
	toSessionEvent,
	vaultToDecl,
} from "./mapper.ts";

export class ClaudeAdapter implements ProviderAdapter {
	readonly name = "claude" as const;
	readonly eventResume = false;
	readonly memoryCapabilities = {
		archive_store: true,
		batch_create: false,
		versions: true,
		optimistic_concurrency: true,
		memory_metadata: false,
	} as const;
	private client: ClaudeClient;
	private memoryClient: ClaudeClient;
	private memoryApi: ProviderMemoryApi;
	private projectName: string;

	constructor(apiKey: string, beta?: string, projectName?: string) {
		this.client = new ClaudeClient({ apiKey, beta });
		// Anthropic rejects agent-memory-2026-07-22 when combined with the
		// managed-agents beta, so Memory Stores use a dedicated client/header.
		this.memoryClient = new ClaudeClient({ apiKey, beta: "agent-memory-2026-07-22" });
		this.memoryApi = new ProviderMemoryApi(this.memoryClient, {
			pathStyle: "absolute",
			cursorParam: "page",
			updatePrecondition: "precondition",
			prefixParam: "path_prefix",
			supportsView: true,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: true,
			supportsIncludeArchived: true,
		});
		this.projectName = projectName ?? "";
	}

	async validate(): Promise<void> {
		await this.client.get("/agents?limit=1");
	}

	private static readonly ENDPOINT_MAP: Partial<Record<ResourceType, string>> = {
		environment: "/environments",
		agent: "/agents",
		vault: "/vaults",
		skill: "/skills",
		memory_store: "/memory_stores",
		deployment: "/deployments",
		file: "/files",
	};

	async findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null> {
		// Claude archives agents (POST /agents/{id}/archive) instead of hard-deleting
		// them; an archived ghost must not count as existing for refresh/adoption.
		const raw = await locateRemote(
			type === "memory_store" ? this.memoryClient : this.client,
			ClaudeAdapter.ENDPOINT_MAP[type],
			name,
			id,
			notArchived,
		);
		return raw ? toRemoteResource(raw) : null;
	}

	async listAgents(filter?: { prefix?: string; limit?: number }): Promise<CloudAgent[]> {
		// A prefix request must scan every page and filter locally so family members on
		// page 2+ are not dropped from the resource center.
		const prefix = filter?.prefix;
		if (prefix) {
			const all = await this.client.getAllPaged("/agents");
			return all.map(toCloudAgent).filter((a) => (a.name ?? "").startsWith(prefix));
		}
		const res = (await this.client.get(`/agents?limit=${filter?.limit ?? 100}`)) as {
			data?: Record<string, unknown>[];
		};
		return (res.data ?? []).map(toCloudAgent);
	}

	async listEnvironments(_filter?: { limit?: number }): Promise<CloudEnvironment[]> {
		const all = await this.client.getAllPaged("/environments");
		return all.map(toCloudEnvironment);
	}

	async listVaults(_filter?: { limit?: number }): Promise<CloudVault[]> {
		const all = await this.client.getAllPaged("/vaults");
		return all.map(toCloudVault);
	}

	async listModels(): Promise<ModelInfo[]> {
		const res = (await this.client.get("/models")) as {
			data?: Record<string, unknown>[];
		};
		return (res.data ?? []).map(toClaudeModelInfo);
	}

	async createEnvironment(name: string, decl: EnvironmentDecl): Promise<RemoteResource> {
		const body = mapEnvironment(name, decl, this.projectName);
		const res = (await this.client.post("/environments", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateEnvironment(id: string, name: string, decl: EnvironmentDecl): Promise<RemoteResource> {
		const body = mapEnvironment(name, decl, this.projectName);
		const res = (await this.client.post(`/environments/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteEnvironment(id: string): Promise<void> {
		await this.client.delete(`/environments/${id}`);
	}

	async createVault(name: string, decl: VaultDecl): Promise<RemoteResource> {
		const injected: Record<string, string> = {
			"agents.project": this.projectName,
			"agents.resource": name,
		};
		const body: Record<string, unknown> = {
			display_name: decl.display_name,
			metadata: { ...injected, ...decl.metadata },
		};
		const res = (await this.client.post("/vaults", body)) as Record<string, unknown>;
		const vaultId = res.id as string;

		if (decl.credentials?.length) {
			for (const cred of decl.credentials) {
				await this.client.post(`/vaults/${vaultId}/credentials`, {
					auth: {
						type: cred.type,
						token: cred.access_token,
						mcp_server_url: cred.mcp_server_url,
					},
					display_name: cred.name,
				});
			}
		}

		return toRemoteResource(res);
	}

	async deleteVault(id: string): Promise<void> {
		await this.client.delete(`/vaults/${id}`);
	}

	async exportResources(type: ResourceType): Promise<ExportedResource[]> {
		return exportRemoteResources(this.client, type, {
			envToDecl,
			vaultToDecl,
			fileToDecl,
			skillToDecl,
			agentToDecl,
		});
	}

	async createSkill(name: string, _decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const formData = buildClaudeSkillFormData(name, files);
		const res = (await this.client.postFormData("/skills", formData)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateSkill(id: string, name: string, _decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const formData = buildClaudeSkillFormData(name, files);
		const res = (await this.client.postFormData(`/skills/${id}/versions`, formData)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteSkill(id: string): Promise<void> {
		// Must delete all versions before deleting the skill
		const versions = (await this.client.get(`/skills/${id}/versions`)) as {
			data: Array<{ version: string }>;
		};
		for (const v of versions.data ?? []) {
			await this.client.delete(`/skills/${id}/versions/${v.version}`);
		}
		await this.client.delete(`/skills/${id}`);
	}

	async listSkills(source?: "custom" | "official"): Promise<ProviderSkillInfo[]> {
		const path = source === "official" ? "/skills?source=official" : "/skills";
		const all = await this.client.getAllPaged(path);
		return all.map(toRestSkillInfo);
	}

	async getSkillInfo(id: string): Promise<ProviderSkillInfo> {
		const res = (await this.client.get(`/skills/${id}`)) as Record<string, unknown>;
		return toRestSkillInfo(res);
	}

	async downloadAllSkillFiles(): Promise<Map<string, SkillFile[]>> {
		const skills = await this.client.getAllPaged("/skills");
		const result = new Map<string, SkillFile[]>();
		for (const skill of skills) {
			const skillId = skill.id as string;
			const displayTitle = (skill.display_title as string) ?? skillId;
			const name = resourceNameFromMetadata(skill.metadata, displayTitle, skillId);
			try {
				// Get the latest version
				const versions = (await this.client.get(`/skills/${skillId}/versions`)) as {
					data: Array<{ version: string }>;
				};
				const latestVersion = versions.data?.[0]?.version;
				if (!latestVersion) continue;
				// Download the zip content
				const zipBuffer = await this.client.getBuffer(`/skills/${skillId}/versions/${latestVersion}/content`);
				const files = await extractSkillZipFiles(zipBuffer);
				result.set(name, files);
			} catch {
				// Skip skills that cannot be downloaded (e.g. permission denied)
			}
		}
		return result;
	}

	async createAgent(name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource> {
		const body = mapAgent(name, decl, refs, undefined, this.projectName);
		const res = (await this.client.post("/agents", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateAgent(id: string, name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource> {
		const current = (await this.client.get(`/agents/${id}`)) as {
			version: number;
		};
		const body = mapAgent(name, decl, refs, current.version, this.projectName);
		const res = (await this.client.post(`/agents/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteAgent(id: string): Promise<void> {
		await this.client.post(`/agents/${id}/archive`, {});
	}

	async createMemoryStore(name: string, decl: MemoryStoreDecl): Promise<RemoteResource> {
		const res = (await this.memoryClient.post("/memory_stores", {
			name,
			description: decl.description,
			metadata: decl.metadata,
		})) as Record<string, unknown>;
		const storeId = String(res.id);
		try {
			for (const entry of decl.entries ?? []) {
				await this.memoryApi.createMemory(storeId, { path: entry.key, content: entry.content });
			}
		} catch (error) {
			await this.memoryClient.delete(`/memory_stores/${storeId}`).catch(() => undefined);
			throw error;
		}
		return toRemoteResource(res);
	}

	async deleteMemoryStore(id: string): Promise<void> {
		await this.memoryClient.delete(`/memory_stores/${id}`);
	}
	listMemoryStores(options?: MemoryStoreListOptions) {
		return this.memoryApi.listStores(options);
	}
	getMemoryStore(id: string) {
		return this.memoryApi.getStore(id);
	}
	updateMemoryStore(id: string, input: UpdateMemoryStoreInput) {
		return this.memoryApi.updateStore(id, input);
	}
	archiveMemoryStore(id: string) {
		return this.memoryApi.archiveStore(id);
	}
	createMemory(storeId: string, input: CreateMemoryInput) {
		return this.memoryApi.createMemory(storeId, input);
	}
	listMemories(storeId: string, options?: MemoryListOptions) {
		return this.memoryApi.listMemories(storeId, options);
	}
	getMemory(storeId: string, memoryId: string) {
		return this.memoryApi.getMemory(storeId, memoryId);
	}
	updateMemory(storeId: string, memoryId: string, input: UpdateMemoryInput) {
		return this.memoryApi.updateMemory(storeId, memoryId, input);
	}
	deleteMemory(storeId: string, memoryId: string, expected?: string) {
		return this.memoryApi.deleteMemory(storeId, memoryId, expected);
	}
	listMemoryVersions(storeId: string, options?: MemoryVersionListOptions) {
		return this.memoryApi.listVersions(storeId, options);
	}
	getMemoryVersion(storeId: string, versionId: string) {
		return this.memoryApi.getVersion(storeId, versionId);
	}
	redactMemoryVersion(storeId: string, versionId: string) {
		return this.memoryApi.redactVersion(storeId, versionId);
	}

	async createDeployment(
		name: string,
		decl: DeploymentDecl,
		refs: ResolvedDeploymentRefs,
		basePath: string,
	): Promise<RemoteResource> {
		const uploaded = await this.uploadDeploymentFiles(decl, basePath);
		const body = mapDeployment(name, decl, refs, this.projectName, uploaded);
		const res = (await this.client.post("/deployments", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateDeployment(
		id: string,
		name: string,
		decl: DeploymentDecl,
		refs: ResolvedDeploymentRefs,
		basePath: string,
	): Promise<RemoteResource> {
		const uploaded = await this.uploadDeploymentFiles(decl, basePath);
		const body = mapDeployment(name, decl, refs, this.projectName, uploaded);
		const res = (await this.client.post(`/deployments/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteDeployment(id: string): Promise<void> {
		await this.client.post(`/deployments/${id}/archive`, {});
	}

	private async uploadDeploymentFiles(decl: DeploymentDecl, basePath: string): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		for (const r of decl.resources ?? []) {
			if (r.type === "file" && !r.file_id && r.source && !map.has(r.source)) {
				map.set(r.source, await this.uploadDeploymentFile(r.source, basePath));
			}
		}
		return map;
	}

	private async uploadDeploymentFile(source: string, basePath: string): Promise<string> {
		const fullPath = resolve(dirname(basePath), source);
		const content = readFileSync(fullPath);
		const formData = new FormData();
		formData.append("file", new File([new Uint8Array(content)], basename(fullPath)));
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		return res.id as string;
	}

	async runDeployment(ctx: DeploymentContext): Promise<DeploymentRunResult> {
		if (!ctx.id) {
			throw new UserError(`Deployment '${ctx.name}' has no remote id; run \`agents apply\` first.`);
		}
		const res = (await this.client.post(`/deployments/${ctx.id}/run`, {})) as Record<string, unknown>;
		return {
			run_id: res.id as string | undefined,
			session_id: (res.session_id as string | null) ?? null,
			error: res.error as { type: string; message: string } | undefined,
		};
	}

	async getDeployment(ctx: DeploymentContext): Promise<DeploymentInfo> {
		if (!ctx.id) {
			throw new UserError(`Deployment '${ctx.name}' has no remote id; run \`agents apply\` first.`);
		}
		const res = (await this.client.get(`/deployments/${ctx.id}`)) as Record<string, unknown>;
		const sched = res.schedule as Record<string, unknown> | undefined;
		return {
			id: res.id as string,
			status: (res.status as string) ?? "unknown",
			paused_reason: res.paused_reason as { type: string; error?: { type: string } } | undefined,
			schedule: sched
				? {
						expression: sched.expression as string,
						timezone: sched.timezone as string | undefined,
					}
				: undefined,
			attributes: res,
		};
	}

	async createSession(bindings: SessionBindings): Promise<ProviderSessionInfo> {
		if (bindings.delivery === "forward") throw new UserError("Claude does not support Forward sessions.");
		const body = mapSession(bindings);
		const res = (await this.client.post("/sessions", body)) as Record<string, unknown>;
		return toSessionInfo(res);
	}

	async listSessions(filter?: SessionFilter): Promise<SessionListResult> {
		const params = new URLSearchParams();
		if (filter?.agent_id) params.set("agent_id", filter.agent_id);
		if (filter?.limit) params.set("limit", String(filter.limit));
		const qs = params.toString();
		const res = (await this.client.get(`/sessions${qs ? `?${qs}` : ""}`)) as Record<string, unknown>;
		const data = (res.data ?? []) as Record<string, unknown>[];
		const nextPage = (res.next_page as string | null | undefined) ?? undefined;
		return {
			sessions: data.map(toSessionInfo),
			has_more: nextPage != null,
			next_page: nextPage,
		};
	}

	async getSession(id: string): Promise<ProviderSessionInfo> {
		const res = (await this.client.get(`/sessions/${id}`)) as Record<string, unknown>;
		return toSessionInfo(res);
	}

	async deleteSession(id: string): Promise<void> {
		await this.client.post(`/sessions/${id}/archive`, {});
	}

	async sendSessionMessage(sessionId: string, message: string): Promise<string | undefined> {
		const body = mapSendMessage(message);
		const res = (await this.client.post(`/sessions/${sessionId}/events`, body)) as Record<string, unknown>;
		return extractCreatedEventId(res);
	}

	async *streamSessionEvents(sessionId: string, _options?: EventStreamOptions): AsyncIterable<ProviderSessionEvent> {
		// The managed-agents stream pushes only post-connect events and rejects a
		// cursor param (`after_id` → HTTP 400 "unknown field"); reconnection is done
		// by replaying history via listSessionEvents and de-duplicating by event id,
		// so `after_id` is intentionally not forwarded (mirrors bailian).
		for await (const raw of this.client.sse(`/sessions/${sessionId}/events/stream`)) {
			yield toSessionEvent(raw);
		}
	}

	async listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList> {
		// The managed-agents events endpoint rejects `after_id` (HTTP 400), so it is
		// never forwarded (mirrors bailian); shared page-cursor handling lives in
		// listSessionEventsPaged.
		return listSessionEventsPaged(this.client, sessionId, options, toSessionEvent);
	}

	// --- Files ---

	async uploadFile(filePath: string, options?: { name?: string; purpose?: string }): Promise<ProviderFileInfo> {
		const resolved = resolve(filePath);
		const content = readFileSync(resolved);
		const fileName = options?.name ?? basename(resolved);
		return this.uploadFileContent(new Uint8Array(content), fileName, {
			purpose: options?.purpose,
		});
	}

	async uploadFileContent(
		content: Uint8Array,
		filename: string,
		options?: { mimeType?: string; purpose?: string },
	): Promise<ProviderFileInfo> {
		const formData = new FormData();
		const bytes = new Uint8Array(content);
		formData.append(
			"file",
			options?.mimeType ? new File([bytes], filename, { type: options.mimeType }) : new File([bytes], filename),
		);
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		return toRestFileInfo(res);
	}

	async getFileInfo(id: string): Promise<ProviderFileInfo> {
		const res = (await this.client.get(`/files/${id}`)) as Record<string, unknown>;
		return toRestFileInfo(res);
	}

	async listFiles(): Promise<ProviderFileInfo[]> {
		const all = await this.client.getAllPaged("/files");
		return all.map(toRestFileInfo);
	}

	async deleteFile(id: string): Promise<void> {
		await this.client.delete(`/files/${id}`);
	}
}

export function toSessionInfo(res: Record<string, unknown>): ProviderSessionInfo {
	return buildSessionInfo(res, (r) =>
		((r.resources as Array<Record<string, unknown>>) ?? [])
			.filter((x) => x.type === "memory_store")
			.map((x) => x.memory_store_id as string),
	);
}

// The Claude Skills API requires every uploaded file to sit under a single top-level
// directory whose name matches the `name:` field in SKILL.md (it rejects a mismatch with
// HTTP 400). Derive the folder from SKILL.md itself so the constraint always holds,
// falling back to the agents resource name when SKILL.md can't be read.
function buildClaudeSkillFormData(name: string, files: SkillFile[]): FormData {
	const formData = new FormData();
	const dirName = skillNameFromFiles(files) ?? name;

	for (const f of files) {
		formData.append("files[]", new File([new Uint8Array(f.content)], `${dirName}/${f.relativePath}`));
	}

	return formData;
}

function toClaudeModelInfo(res: Record<string, unknown>): ModelInfo {
	// The managed-agents /models list carries id + display_name (+ token limits and a
	// capabilities map the resource picker ignores). It has no enablement/newness flags,
	// so surface every listed model as an enabled anthropic model.
	return {
		id: res.id as string,
		display_name: (res.display_name as string) ?? (res.id as string),
		source: "anthropic",
		is_enabled: true,
		is_new: false,
	};
}

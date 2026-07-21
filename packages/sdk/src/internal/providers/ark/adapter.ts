import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import JSZip from "jszip";
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
	BatchCreateMemoryInput,
	CreateMemoryInput,
	MemoryListOptions,
	MemoryStoreListOptions,
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
import { skillNameFromFiles } from "../../utils/skill-manifest.ts";
import { ApiError, ConflictError, toRemoteResource } from "../base-client.ts";
import type {
	DeploymentContext,
	DeploymentInfo,
	DeploymentRunResult,
	DriftSupport,
	ExportedResource,
	ProviderAdapter,
	RemoteResource,
	ResolvedAgentRefs,
	ResolvedDeploymentRefs,
} from "../interface.ts";
import { ProviderMemoryApi } from "../memory-api.ts";
import { arkEnvironmentWireNameAttempt, normalizeWireResourceName } from "../resource-naming.ts";
import { extractCreatedEventId, listSessionEventsPaged } from "../session-event-response.ts";
import {
	buildSessionInfo,
	exportRemoteResources,
	locateRemote,
	toCloudAgent,
	toCloudEnvironment,
	toCloudVault,
	toRestFileInfo,
	toRestSkillInfo,
} from "../shared.ts";
import { ArkClient } from "./client.ts";
import {
	agentToDecl,
	envToDecl,
	fileToDecl,
	mapAgent,
	mapDeploymentToSession,
	mapEnvironment,
	mapMemoryStore,
	mapSendMessage,
	mapSession,
	skillToDecl,
	toSessionEvent,
	vaultToDecl,
} from "./mapper.ts";

export class ArkAdapter implements ProviderAdapter {
	readonly name = "ark" as const;
	readonly eventResume = false;
	readonly memoryCapabilities = {
		archive_store: false,
		batch_create: true,
		versions: false,
		optimistic_concurrency: false,
		memory_metadata: false,
	} as const;
	private client: ArkClient;
	private memoryApi: ProviderMemoryApi;
	private projectName: string;

	constructor(apiKey: string, projectName?: string) {
		this.client = new ArkClient({ apiKey });
		this.memoryApi = new ProviderMemoryApi(this.client, {
			pathStyle: "absolute",
			cursorParam: "page",
			updatePrecondition: "none",
			prefixParam: "path_prefix",
			supportsView: false,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: false,
			supportsIncludeArchived: false,
		});
		this.projectName = projectName ?? "";
	}

	async validate(): Promise<void> {
		await this.client.get("/agents?limit=1");
	}

	// deployment omitted: emulated on Ark, no remote listing endpoint.
	private static readonly ENDPOINT_MAP: Partial<Record<ResourceType, string>> = {
		environment: "/environments",
		agent: "/agents",
		vault: "/vaults",
		skill: "/skills",
		memory_store: "/memory_stores",
		file: "/files",
	};

	async findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null> {
		// Ark has no skill list/search endpoint (GET /skills → 404); only lookup by id works
		// (GET /skills/{id} → 200). A name-only lookup can't resolve, so report "not found"
		// and let the caller create a fresh skill.
		if (type === "skill" && !id) return null;
		const raw = await locateRemote(this.client, ArkAdapter.ENDPOINT_MAP[type], name, id);
		return raw ? toRemoteResource(raw) : null;
	}

	getDriftSupport(type: ResourceType): DriftSupport {
		if (type === "deployment") return "unsupported";
		return ArkAdapter.ENDPOINT_MAP[type] ? "existence" : "unsupported";
	}

	async listAgents(filter?: { prefix?: string; limit?: number }): Promise<CloudAgent[]> {
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

	async createEnvironment(name: string, decl: EnvironmentDecl): Promise<RemoteResource> {
		const baseWireName = normalizeWireResourceName("ark", "environment", name);
		const maxAttempts = 16;
		let lastError: unknown;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const wireName = arkEnvironmentWireNameAttempt(baseWireName, attempt);
			const body = mapEnvironment(name, decl, this.projectName, wireName);
			try {
				const res = (await this.client.post("/environments", body)) as Record<string, unknown>;
				return toRemoteResource(res);
			} catch (err) {
				lastError = err;
				if (!(err instanceof ConflictError) || attempt === maxAttempts - 1) throw err;
			}
		}

		throw lastError;
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
				const auth: Record<string, unknown> =
					cred.type === "environment_variable"
						? {
								type: "environment_variable",
								secret_name: cred.secret_name,
								secret_value: cred.secret_value,
								networking: cred.networking ?? { type: "unrestricted" },
							}
						: {
								type: cred.type,
								mcp_server_url: cred.mcp_server_url,
								token: cred.access_token,
							};
				await this.client.post(`/vaults/${vaultId}/credentials`, {
					auth,
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
		// Ark has no skill list endpoint, so default sync must skip skills instead of
		// failing the whole export on GET /skills. Existing stateful skill refs can still
		// be refreshed by id through getSkillInfo/findResource.
		if (type === "skill") return [];
		return exportRemoteResources(this.client, type, {
			envToDecl,
			vaultToDecl,
			fileToDecl,
			skillToDecl,
			agentToDecl,
		});
	}

	// Ark skills support create + get + attach only. There is no list/update/delete endpoint
	// (GET /skills, PUT /skills/{id}, DELETE /skills/{id} all return 404 on real probe), so:
	//   - updateSkill re-uploads (create) — Ark has no in-place version/update endpoint.
	//   - deleteSkill still issues DELETE (Ark returns 404 — a real API limitation that only
	//     surfaces on `agents destroy`).
	//   - listSkills/downloadAllSkillFiles are intentionally not implemented.
	async createSkill(name: string, _decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const formData = await buildArkSkillFormData(name, files);
		const res = (await this.client.postFormData("/skills", formData)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateSkill(_id: string, name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		return this.createSkill(name, decl, files);
	}

	// Ark has no DeleteSkill endpoint (DELETE /skills/{id} → 404). Uploaded skills cannot be
	// removed via the API, so destroy is best-effort: swallow the 404 and drop it from state.
	async deleteSkill(id: string): Promise<void> {
		try {
			await this.client.delete(`/skills/${id}`);
		} catch (err) {
			if (ApiError.isNotFound(err)) return;
			throw err;
		}
	}

	async getSkillInfo(id: string): Promise<ProviderSkillInfo> {
		const res = (await this.client.get(`/skills/${id}`)) as Record<string, unknown>;
		return toRestSkillInfo(res);
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
		await this.client.delete(`/agents/${id}`);
	}

	async createMemoryStore(name: string, decl: MemoryStoreDecl): Promise<RemoteResource> {
		const body = mapMemoryStore(name, decl);
		const res = (await this.client.post("/memory_stores", body)) as Record<string, unknown>;
		const storeId = res.id as string;
		try {
			for (const entry of decl.entries ?? []) {
				await this.memoryApi.createMemory(storeId, { content: entry.content, path: entry.key });
			}
		} catch (error) {
			await this.client.delete(`/memory_stores/${storeId}`).catch(() => undefined);
			throw error;
		}

		return toRemoteResource(res);
	}

	async deleteMemoryStore(id: string): Promise<void> {
		await this.client.delete(`/memory_stores/${id}`);
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
	createMemory(storeId: string, input: CreateMemoryInput) {
		return this.memoryApi.createMemory(storeId, input);
	}
	batchCreateMemories(storeId: string, input: BatchCreateMemoryInput) {
		return this.memoryApi.batchCreateMemories(storeId, input);
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

	// --- Deployment (emulated) ---
	// Ark has no /deployments endpoint. A deployment is recorded in state with
	// remote_id = null and materialized into a session at run time (mirrors qoder).

	async createDeployment(
		_name: string,
		_decl: DeploymentDecl,
		_refs: ResolvedDeploymentRefs,
		_basePath: string,
	): Promise<RemoteResource> {
		return { id: null, type: "deployment" };
	}

	async updateDeployment(
		_id: string,
		_name: string,
		_decl: DeploymentDecl,
		_refs: ResolvedDeploymentRefs,
		_basePath: string,
	): Promise<RemoteResource> {
		return { id: null, type: "deployment" };
	}

	async deleteDeployment(_id: string): Promise<void> {
		// Emulated: no remote object to delete.
	}

	async runDeployment(ctx: DeploymentContext): Promise<DeploymentRunResult> {
		const fileIds: string[] = [];
		for (const r of ctx.decl.resources ?? []) {
			if (r.type === "file") {
				if (r.file_id) {
					fileIds.push(r.file_id);
				} else if (r.source) {
					fileIds.push(await this.uploadSessionFile(r.source, ctx.basePath));
				}
			}
		}

		const body = mapDeploymentToSession(ctx.decl, ctx.refs, fileIds);
		const sessionRes = (await this.client.post("/sessions", body)) as Record<string, unknown>;
		const sessionId = sessionRes.id as string;

		// Ark only supports `user.message` as an outbound event; a system.message is
		// delivered as a user.message. define_outcome events are dropped (warned at plan time).
		const events = ctx.decl.initial_events
			.filter((e) => e.type === "user.message" || e.type === "system.message")
			.map((e) => ({
				type: "user.message",
				content: [{ type: "text", text: (e as { content: string }).content }],
			}));

		if (events.length) {
			await this.client.post(`/sessions/${sessionId}/events`, { events });
		}

		return { session_id: sessionId };
	}

	async getDeployment(ctx: DeploymentContext): Promise<DeploymentInfo> {
		const plan = mapDeploymentToSession(ctx.decl, ctx.refs, []);
		return {
			id: ctx.id,
			status: "emulated (local)",
			schedule: ctx.decl.schedule,
			attributes: { materialization_plan: plan },
		};
	}

	private async uploadSessionFile(source: string, basePath: string): Promise<string> {
		const fullPath = resolve(dirname(basePath), source);
		const content = readFileSync(fullPath);
		const formData = new FormData();
		formData.append("file", new File([new Uint8Array(content)], basename(fullPath)));
		// Ark requires `purpose` ∈ {user_data, agent}. Session-mounted files use `agent`
		// (per docs); `user_data` restricts accepted MIME types and rejects text/plain.
		formData.append("purpose", "agent");
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		return (res.file_id as string) ?? (res.id as string);
	}

	async createSession(bindings: SessionBindings): Promise<ProviderSessionInfo> {
		if (bindings.delivery === "forward") throw new UserError("Ark does not support Forward sessions.");
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
		await this.client.delete(`/sessions/${id}`);
	}

	async sendSessionMessage(sessionId: string, message: string): Promise<string | undefined> {
		const body = mapSendMessage(message);
		const res = (await this.client.post(`/sessions/${sessionId}/events`, body)) as Record<string, unknown>;
		return extractCreatedEventId(res);
	}

	async *streamSessionEvents(sessionId: string, _options?: EventStreamOptions): AsyncIterable<ProviderSessionEvent> {
		// Like claude/bailian: the stream pushes only post-connect events and rejects a
		// cursor param; reconnection replays history via listSessionEvents + de-dup by id.
		for await (const raw of this.client.sse(`/sessions/${sessionId}/events/stream`)) {
			yield toSessionEvent(raw);
		}
	}

	async listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList> {
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
		// Ark requires `purpose` ∈ {user_data, agent}. Default to `agent` (files meant for
		// the agent to read); `user_data` restricts accepted MIME types and rejects text/plain.
		formData.append("purpose", options?.purpose ?? "agent");
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

// Ark accepts multipart `files[]` uploads where each part's filename is a relative path
// under a single top-level directory (mirrors the claude skills upload). Unlike claude,
// Ark's CreateSkill only accepts a single zip in the `files` field ("files: only one zip
// file is supported"); the documented `files[]` multipart form is rejected by the live API.
// The skill name is derived server-side from the zip's top-level directory, so we prefix
// every entry with that folder.
async function buildArkSkillFormData(name: string, files: SkillFile[]): Promise<FormData> {
	const dirName = skillNameFromFiles(files) ?? name;
	const zip = new JSZip();
	for (const f of files) {
		zip.file(`${dirName}/${f.relativePath}`, f.content);
	}
	const zipContent = await zip.generateAsync({ type: "uint8array" });

	const formData = new FormData();
	formData.append(
		"files",
		new File([new Uint8Array(zipContent)], `${dirName}.zip`, {
			type: "application/zip",
		}),
	);
	return formData;
}

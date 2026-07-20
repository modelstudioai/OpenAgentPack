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
	ForwardSessionBindings,
	ProviderSessionInfo,
	SessionBindings,
	SessionFilter,
	SessionListResult,
} from "../../types/session.ts";
import type {
	EventListOptions,
	EventStreamOptions,
	ProviderSessionEvent,
	ProviderSessionEventList,
} from "../../types/session-event.ts";
import type { SkillFile } from "../../types/skill-file.ts";
import type { ProviderSkillInfo } from "../../types/skill-info.ts";
import type { ResourceType } from "../../types/state.ts";
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import { ApiError, toRemoteResource } from "../base-client.ts";
import type {
	ComparableRemoteResource,
	DeploymentContext,
	DeploymentInfo,
	DeploymentRunResult,
	DriftSupport,
	ExportedResource,
	ModelInfo,
	ProviderAdapter,
	RemoteResource,
	ResolvedAgentRefs,
	ResolvedDeploymentRefs,
	ResolvedTemplateRefs,
} from "../interface.ts";
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
import { QoderClient } from "./client.ts";
import {
	agentToDecl,
	envToDecl,
	fileToDecl,
	mapAgent,
	mapCredential,
	mapDeployment,
	mapEnvironment,
	mapForwardTemplate,
	mapMemoryStore,
	mapSendMessage,
	mapSession,
	mapVault,
	normalizeToolNameFromQoder,
	skillToDecl,
	toSessionEvent,
	vaultToDecl,
} from "./mapper.ts";

function deriveForwardGateway(cloudGateway?: string): string {
	if (!cloudGateway) return "https://api.qoder.com/api/v1/forward";
	const trimmed = cloudGateway.replace(/\/$/, "");
	return trimmed.endsWith("/cloud") ? `${trimmed.slice(0, -"/cloud".length)}/forward` : `${trimmed}/forward`;
}

const QODER_DEFAULT_IDENTITY_EXTERNAL_ID = "__qca_admin_identity__";

export class QoderAdapter implements ProviderAdapter {
	readonly name = "qoder" as const;
	readonly eventResume = true;
	private client: QoderClient;
	private forwardClient: QoderClient;
	private projectName: string;
	private forwardSessionIds = new Set<string>();
	private defaultForwardIdentityId?: string;

	constructor(apiKey: string, gateway?: string, projectName?: string, forwardGateway?: string) {
		this.client = new QoderClient({ apiKey, gateway });
		this.forwardClient = new QoderClient({
			apiKey,
			gateway: forwardGateway ?? deriveForwardGateway(gateway),
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
		file: "/files",
		// deployment omitted: emulated on Qoder, no remote listing endpoint
	};

	async findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null> {
		if (type === "template") {
			const raw = await locateRemote(this.forwardClient, "/templates", name, id, (item) => item.status !== "archived");
			return raw ? toRemoteResource(raw) : null;
		}
		const raw = await locateRemote(this.client, QoderAdapter.ENDPOINT_MAP[type], name, id, notArchived);
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

	async listFiles(): Promise<ProviderFileInfo[]> {
		const all = await this.client.getAllPaged("/files");
		return all.map(toRestFileInfo);
	}

	async getFileInfo(id: string): Promise<ProviderFileInfo> {
		const res = (await this.client.get(`/files/${id}`)) as Record<string, unknown>;
		return toRestFileInfo(res);
	}

	async getFileDownloadUrl(id: string): Promise<{ url: string; expires_at?: string }> {
		const res = (await this.client.get(`/files/${id}/content`)) as Record<string, unknown>;
		return {
			url: res.url as string,
			expires_at: typeof res.expires_at === "string" ? res.expires_at : undefined,
		};
	}

	async listSkills(source?: "custom" | "official"): Promise<ProviderSkillInfo[]> {
		// Qoder's built-in catalog is requested as `?source=qoder` (NOT `official`, which
		// the API rejects with HTTP 400); the default page is the workspace custom catalog.
		const path = source === "official" ? "/skills?source=qoder" : "/skills";
		const all = await this.client.getAllPaged(path);
		return all.map(toRestSkillInfo);
	}

	async getSkillInfo(id: string): Promise<ProviderSkillInfo> {
		const res = (await this.client.get(`/skills/${id}`)) as Record<string, unknown>;
		return toRestSkillInfo(res);
	}

	getDriftSupport(type: ResourceType): DriftSupport {
		if (type === "agent" || type === "environment" || type === "template") return "full";
		if (type === "deployment") return "unsupported";
		return QoderAdapter.ENDPOINT_MAP[type] ? "existence" : "unsupported";
	}

	async readComparableResource(
		type: ResourceType,
		id: string | null,
		name: string,
	): Promise<ComparableRemoteResource | null> {
		if (type !== "agent" && type !== "environment" && type !== "template") return null;
		const isTemplate = type === "template";
		const endpoint = type === "agent" ? "/agents" : type === "environment" ? "/environments" : "/templates";
		const raw = await locateRemote(
			isTemplate ? this.forwardClient : this.client,
			endpoint,
			name,
			id,
			isTemplate ? (item) => item.status !== "archived" : notArchived,
		);
		if (!raw) return null;

		const comparable = this.normalizeRemote(type, raw);
		return {
			id: (raw.id as string | undefined) ?? id,
			type,
			version: raw.version as number | undefined,
			comparable,
			snapshot: comparable,
		};
	}

	normalizeDesiredResource(type: ResourceType, name: string, decl: unknown): unknown | null {
		if (type === "environment") {
			return this.normalizeRemote(
				type,
				mapEnvironment(name, decl as EnvironmentDecl, this.projectName) as Record<string, unknown>,
			);
		}
		if (type === "agent") {
			return this.normalizeRemote(
				type,
				mapAgent(name, decl as AgentDecl, { skill_ids: [] }, undefined, this.projectName) as Record<string, unknown>,
			);
		}
		if (type === "template") return null;
		return null;
	}

	private normalizeRemote(type: ResourceType, raw: Record<string, unknown>): unknown {
		if (type === "environment") {
			const config = (raw.config ?? {}) as Record<string, unknown>;
			return compactDeep({
				description: raw.description,
				config: {
					type: config.type ?? "cloud",
					networking: config.networking,
					packages: config.packages,
				},
				metadata: stripAgentsMetadata(raw.metadata),
			});
		}
		if (type === "template") {
			return compactDeep({
				name: raw.name,
				description: raw.description,
				model: raw.model,
				system: raw.system,
				tools: raw.tools,
				mcp_servers: raw.mcp_servers,
				skills: raw.skills,
				multiagent: raw.multiagent,
				environment_id: raw.environment_id,
				tunnel_id: raw.tunnel_id,
				vault_ids: Array.isArray(raw.vault_ids)
					? raw.vault_ids
					: Object.keys((raw.vaults ?? {}) as Record<string, unknown>),
				files: raw.files,
				environment_variables: raw.environment_variables,
				metadata: stripAgentsMetadata(raw.metadata),
			});
		}

		return compactDeep({
			description: raw.description,
			model: normalizeModel(raw.model),
			instructions: raw.system,
			tools: normalizeQoderTools(raw.tools),
			mcp_servers: normalizeQoderMcpServers(raw.mcp_servers),
			metadata: stripAgentsMetadata(raw.metadata),
		});
	}

	async createEnvironment(name: string, decl: EnvironmentDecl): Promise<RemoteResource> {
		const body = mapEnvironment(name, decl, this.projectName);
		const res = (await this.client.post("/environments", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateEnvironment(id: string, name: string, decl: EnvironmentDecl): Promise<RemoteResource> {
		const body = mapEnvironment(name, decl, this.projectName);
		const res = (await this.client.put(`/environments/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteEnvironment(id: string, cascade = false): Promise<void> {
		try {
			await this.client.delete(`/environments/${id}`);
			return;
		} catch (err) {
			const isConflict = err instanceof ApiError && (err.statusCode === 409 || err.responseBody.includes("in use"));
			if (!isConflict) throw err;
		}

		// Environment is referenced by sessions.
		// Scan every page: a single `?limit=100` page could miss blocking
		// sessions past the first 100, leaving the environment undeletable.
		const sessions = (await this.client.getAllPaged("/sessions")) as Array<{
			id: string;
			environment_id: string;
			status: string;
		}>;
		const blocking = sessions.filter((s) => s.environment_id === id);

		if (!cascade) {
			const ids = blocking.map((s) => `${s.id} (${s.status})`).join(", ");
			throw new UserError(
				`Environment ${id} is referenced by ${blocking.length} session(s): ${ids}. ` +
					`Use --cascade to delete them automatically.`,
			);
		}

		for (const s of blocking) {
			await this.client.delete(`/sessions/${s.id}`);
		}

		try {
			await this.client.delete(`/environments/${id}`);
		} catch (err) {
			// The retry can still fail with 409 when the blocking sessions are
			// invisible to the list endpoint (Qoder keeps a stale reference
			// counter for sessions that have completed or been auto-cleaned).
			// Fall back to archiving — Qoder's own error message recommends
			// "Archive the environment instead", and an archived environment is
			// inactive and no longer billable.
			const stillConflict = err instanceof ApiError && (err.statusCode === 409 || err.responseBody.includes("in use"));
			if (!stillConflict) throw err;
			await this.client.post(`/environments/${id}/archive`, {});
		}
	}

	async createVault(name: string, decl: VaultDecl): Promise<RemoteResource> {
		const body = mapVault(name, decl, this.projectName);
		const res = (await this.client.post("/vaults", body)) as Record<string, unknown>;
		const vaultId = res.id as string;
		// Credentials are not accepted inline at vault creation; add each via the
		// dedicated endpoint (mirrors the bailian adapter's two-step flow).
		for (const cred of decl.credentials ?? []) {
			await this.client.post(`/vaults/${vaultId}/credentials`, mapCredential(cred));
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

	async createSkill(name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const formData = await buildSkillFormData(name, decl, files);
		const res = (await this.client.postFormData("/skills", formData)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateSkill(id: string, name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		await this.client.delete(`/skills/${id}`);
		return this.createSkill(name, decl, files);
	}

	async deleteSkill(id: string): Promise<void> {
		await this.client.delete(`/skills/${id}`);
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
		const res = (await this.client.put(`/agents/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteAgent(id: string): Promise<void> {
		await this.client.delete(`/agents/${id}`);
	}

	async createTemplate(name: string, decl: AgentDecl, refs: ResolvedTemplateRefs): Promise<RemoteResource> {
		await this.registerForwardVaults(refs.vault_ids);
		const body = mapForwardTemplate(name, decl, refs, this.projectName);
		const res = (await this.forwardClient.post("/templates", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateTemplate(id: string, name: string, decl: AgentDecl, refs: ResolvedTemplateRefs): Promise<RemoteResource> {
		await this.registerForwardVaults(refs.vault_ids);
		const body = mapForwardTemplate(name, decl, refs, this.projectName) as Record<string, unknown>;
		// Forward updates are merge-style; null explicitly clears a previously inherited BYOC tunnel.
		if (!refs.tunnel_id) body.tunnel_id = null;
		const res = (await this.forwardClient.post(`/templates/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async archiveTemplate(id: string): Promise<void> {
		await this.forwardClient.post(`/templates/${id}/archive`, {});
	}

	private async registerForwardVaults(vaultIds: string[]): Promise<void> {
		for (const id of vaultIds) {
			await this.forwardClient.post("/resources/registry", {
				type: "vault",
				resource: { id },
			});
		}
	}

	async createMemoryStore(name: string, decl: MemoryStoreDecl): Promise<RemoteResource> {
		const body = mapMemoryStore(name, decl);
		const res = (await this.client.post("/memory_stores", body)) as Record<string, unknown>;
		const storeId = res.id as string;

		if (decl.entries?.length) {
			for (const entry of decl.entries) {
				await this.client.post(`/memory_stores/${storeId}/memories`, {
					content: entry.content,
					path: entry.key,
				});
			}
		}

		return toRemoteResource(res);
	}

	async deleteMemoryStore(id: string): Promise<void> {
		await this.client.delete(`/memory_stores/${id}`);
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

	async runDeployment(ctx: DeploymentContext): Promise<DeploymentRunResult> {
		if (!ctx.id) {
			throw new UserError(`Deployment '${ctx.name}' has no remote id; run \`agents apply\` first.`);
		}
		const res = (await this.client.post(`/deployments/${ctx.id}/run`, {})) as Record<string, unknown>;
		return {
			run_id: res.id as string | undefined,
			session_id: (res.session_id as string | null) ?? null,
			error: (res.error as { type: string; message: string } | null | undefined) ?? undefined,
		};
	}

	async getDeployment(ctx: DeploymentContext): Promise<DeploymentInfo> {
		if (!ctx.id) {
			throw new UserError(`Deployment '${ctx.name}' has no remote id; run \`agents apply\` first.`);
		}
		const res = (await this.client.get(`/deployments/${ctx.id}`)) as Record<string, unknown>;
		const sched = res.schedule as Record<string, unknown> | null | undefined;
		return {
			id: res.id as string,
			status: (res.status as string) ?? "unknown",
			paused_reason: res.paused_reason as { type: string; error?: { type: string } } | undefined,
			schedule: sched
				? {
						expression: sched.expression as string,
						timezone: sched.timezone as string,
					}
				: undefined,
			attributes: res,
		};
	}

	private async uploadDeploymentFiles(decl: DeploymentDecl, basePath: string): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		for (const r of decl.resources ?? []) {
			if (r.type === "file" && !r.file_id && r.source && !map.has(r.source)) {
				map.set(r.source, await this.uploadSessionFile(r.source, basePath));
			}
		}
		return map;
	}

	private async uploadSessionFile(source: string, basePath: string): Promise<string> {
		const fullPath = resolve(dirname(basePath), source);
		const content = readFileSync(fullPath);
		const formData = new FormData();
		formData.append("file", new File([new Uint8Array(content)], basename(fullPath)));
		formData.append("purpose", "session_resource");
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		return (res.file_id as string) ?? (res.id as string);
	}

	async createSession(bindings: SessionBindings): Promise<ProviderSessionInfo> {
		if (bindings.delivery === "forward") {
			const identityId = bindings.identity_id ?? (await this.resolveDefaultForwardIdentityId());
			const body: Record<string, unknown> = {
				identity_id: identityId,
				template_id: bindings.template_id,
				incremental_streaming_enabled: false,
			};
			if (bindings.title) body.title = bindings.title;
			if (bindings.metadata) body.metadata = bindings.metadata;
			if (bindings.files?.length) {
				body.resources = bindings.files.map((file) => ({
					type: "file",
					file_id: file.file_id,
					mount_path: file.mount_path,
				}));
			}
			const res = (await this.forwardClient.post("/sessions", body)) as Record<string, unknown>;
			const info = toForwardSessionInfo(res, bindings);
			this.forwardSessionIds.add(info.id);
			return info;
		}
		const body = mapSession(bindings);
		const res = (await this.client.post("/sessions", body)) as Record<string, unknown>;
		return toSessionInfo(res);
	}

	private async resolveDefaultForwardIdentityId(): Promise<string> {
		if (this.defaultForwardIdentityId) return this.defaultForwardIdentityId;

		let afterId: string | undefined;
		do {
			const params = new URLSearchParams({ limit: "100" });
			if (afterId) params.set("after_id", afterId);
			const res = (await this.forwardClient.get(`/identities?${params}`)) as Record<string, unknown>;
			const identities = (res.data ?? []) as Record<string, unknown>[];
			const match = identities.find(
				(identity) =>
					identity.external_id === QODER_DEFAULT_IDENTITY_EXTERNAL_ID &&
					identity.enabled !== false &&
					identity.archived !== true,
			);
			if (typeof match?.id === "string") {
				this.defaultForwardIdentityId = match.id;
				return match.id;
			}

			const hasMore = (res.has_more as boolean | undefined) ?? false;
			const nextId = hasMore ? ((res.last_id as string | null | undefined) ?? undefined) : undefined;
			if (!nextId || nextId === afterId) break;
			afterId = nextId;
		} while (afterId);

		throw new UserError(
			`Qoder default Forward Identity '${QODER_DEFAULT_IDENTITY_EXTERNAL_ID}' was not found. ` +
				`Ask Qoder to provision it, set defaults.session.qoder.identity_id, or pass --identity-id.`,
		);
	}

	async listSessions(filter?: SessionFilter): Promise<SessionListResult> {
		if (filter?.agent_id?.startsWith("tmpl_")) {
			const params = new URLSearchParams({ template_id: filter.agent_id });
			if (filter.limit) params.set("limit", String(filter.limit));
			if (filter.page) params.set("after_id", filter.page);
			const res = (await this.forwardClient.get(`/sessions?${params}`)) as Record<string, unknown>;
			const data = (res.data ?? []) as Record<string, unknown>[];
			const hasMore = (res.has_more as boolean | undefined) ?? false;
			const nextPage = hasMore ? ((res.last_id as string | null | undefined) ?? undefined) : undefined;
			for (const item of data) {
				if (typeof item.id === "string") this.forwardSessionIds.add(item.id);
			}
			return {
				sessions: data.map((item) => toForwardSessionInfo(item)),
				has_more: hasMore,
				next_page: nextPage,
			};
		}
		const params = new URLSearchParams();
		if (filter?.agent_id) params.set("agent_id", filter.agent_id);
		if (filter?.limit) params.set("limit", String(filter.limit));
		const qs = params.toString();
		const res = (await this.client.get(`/sessions${qs ? `?${qs}` : ""}`)) as Record<string, unknown>;
		const data = (res.data ?? []) as Record<string, unknown>[];
		const nextPage = (res.next_page as string | null | undefined) ?? undefined;
		return {
			sessions: data.map(toSessionInfo),
			has_more: (res.has_more as boolean) ?? nextPage != null,
			next_page: nextPage,
		};
	}

	async getSession(id: string): Promise<ProviderSessionInfo> {
		if (this.forwardSessionIds.has(id)) return this.getForwardSession(id);
		try {
			const res = (await this.client.get(`/sessions/${id}`)) as Record<string, unknown>;
			return toSessionInfo(res);
		} catch (error) {
			if (!ApiError.isNotFound(error)) throw error;
			return this.getForwardSession(id);
		}
	}

	async deleteSession(id: string): Promise<void> {
		if (this.forwardSessionIds.has(id)) {
			await this.forwardClient.post(`/sessions/${id}/archive`, {});
			return;
		}
		try {
			await this.client.delete(`/sessions/${id}`);
		} catch (error) {
			if (!ApiError.isNotFound(error)) throw error;
			await this.forwardClient.post(`/sessions/${id}/archive`, {});
			this.forwardSessionIds.add(id);
		}
	}

	async sendSessionMessage(sessionId: string, message: string): Promise<string | undefined> {
		const body = mapSendMessage(message);
		if (this.forwardSessionIds.has(sessionId)) {
			const res = (await this.forwardClient.post(`/sessions/${sessionId}/events`, body)) as Record<string, unknown>;
			return extractCreatedEventId(res);
		}
		try {
			const res = (await this.client.post(`/sessions/${sessionId}/events`, body)) as Record<string, unknown>;
			return extractCreatedEventId(res);
		} catch (error) {
			if (!ApiError.isNotFound(error)) throw error;
			const res = (await this.forwardClient.post(`/sessions/${sessionId}/events`, body)) as Record<string, unknown>;
			this.forwardSessionIds.add(sessionId);
			return extractCreatedEventId(res);
		}
	}

	async *streamSessionEvents(sessionId: string, options?: EventStreamOptions): AsyncIterable<ProviderSessionEvent> {
		if (this.forwardSessionIds.has(sessionId)) {
			yield* this.streamForwardSessionEvents(sessionId, options);
			return;
		}
		// Client-side fallback: skip events locally without passing after_id to
		// the server. This avoids a conflict where the server honours after_id
		// (omitting that event from the stream) and the client never finds the
		// marker, causing all events to be silently dropped.
		const path = `/sessions/${sessionId}/events/stream`;

		let skipping = !!options?.after_id;
		const afterId = options?.after_id;

		try {
			for await (const raw of this.client.sse(path)) {
				if (skipping) {
					const eventId = raw.id as string | undefined;
					if (eventId === afterId) {
						// Found our marker event; stop skipping from next event onward.
						skipping = false;
					}
					continue;
				}
				yield toSessionEvent(raw);
			}
		} catch (error) {
			if (!ApiError.isNotFound(error)) throw error;
			this.forwardSessionIds.add(sessionId);
			yield* this.streamForwardSessionEvents(sessionId, options);
		}
	}

	async listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList> {
		if (this.forwardSessionIds.has(sessionId)) return this.listForwardSessionEvents(sessionId, options);
		// Qoder additionally accepts the Agents-style `after_id` resume marker, so it is
		// forwarded (claude/bailian reject it); shared page-cursor handling lives in
		// listSessionEventsPaged.
		try {
			return await listSessionEventsPaged(this.client, sessionId, options, toSessionEvent, { forwardAfterId: true });
		} catch (error) {
			if (!ApiError.isNotFound(error)) throw error;
			this.forwardSessionIds.add(sessionId);
			return this.listForwardSessionEvents(sessionId, options);
		}
	}

	private async getForwardSession(id: string): Promise<ProviderSessionInfo> {
		const res = (await this.forwardClient.get(`/sessions/${id}`)) as Record<string, unknown>;
		this.forwardSessionIds.add(id);
		return toForwardSessionInfo(res);
	}

	private async *streamForwardSessionEvents(
		sessionId: string,
		options?: EventStreamOptions,
	): AsyncIterable<ProviderSessionEvent> {
		const headers = options?.after_id ? { "Last-Event-ID": options.after_id } : undefined;
		for await (const raw of this.forwardClient.sse(`/sessions/${sessionId}/events/stream`, { headers })) {
			yield toSessionEvent(raw);
		}
	}

	private async listForwardSessionEvents(
		sessionId: string,
		options?: EventListOptions,
	): Promise<ProviderSessionEventList> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.order) params.set("order", options.order);
		const afterId = options?.after_id ?? options?.page_token ?? options?.page;
		if (afterId) params.set("after_id", afterId);
		const query = params.toString();
		const res = (await this.forwardClient.get(`/sessions/${sessionId}/events${query ? `?${query}` : ""}`)) as Record<
			string,
			unknown
		>;
		const data = (res.data ?? []) as Record<string, unknown>[];
		const hasMore = (res.has_more as boolean | undefined) ?? false;
		return {
			events: data.map(toSessionEvent),
			has_more: hasMore,
			next_page: hasMore ? ((res.last_id as string | null | undefined) ?? undefined) : undefined,
		};
	}

	async listModels(): Promise<ModelInfo[]> {
		const res = (await this.client.get("/models")) as { data: ModelInfo[] };
		return res.data;
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
		if (filename) formData.append("name", filename);
		if (options?.purpose) formData.append("purpose", options.purpose);
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		return toRestFileInfo(res);
	}

	async deleteFile(id: string): Promise<void> {
		await this.client.delete(`/files/${id}`);
	}
}

export function toSessionInfo(res: Record<string, unknown>): ProviderSessionInfo {
	return buildSessionInfo(res, (r) => (r.memory_store_ids as string[]) ?? []);
}

function toForwardSessionInfo(res: Record<string, unknown>, bindings?: ForwardSessionBindings): ProviderSessionInfo {
	const template = (res.template ?? {}) as Record<string, unknown>;
	const templateId =
		(res.template_id as string | undefined) ?? (template.id as string | undefined) ?? bindings?.template_id ?? "";
	const environmentId =
		(res.environment_id as string | undefined) ?? (template.environment_id as string | undefined) ?? "";
	return {
		id: res.id as string,
		agent_id: templateId,
		environment_id: environmentId,
		tunnel_id: (res.tunnel_id as string | undefined) ?? (template.tunnel_id as string | undefined),
		status: (res.status as string | undefined) ?? "unknown",
		title: res.title as string | undefined,
		vault_ids: (res.vault_ids as string[] | undefined) ?? [],
		memory_store_ids: (res.memory_store_ids as string[] | undefined) ?? [],
		created_at: (res.created_at as string | undefined) ?? new Date(0).toISOString(),
		updated_at:
			(res.updated_at as string | undefined) ?? (res.created_at as string | undefined) ?? new Date(0).toISOString(),
		attributes: res,
	};
}

function normalizeModel(value: unknown): unknown {
	if (value && typeof value === "object" && "id" in value) {
		return (value as Record<string, unknown>).id;
	}
	return value;
}

function normalizeQoderTools(value: unknown): unknown {
	if (!Array.isArray(value)) return undefined;
	const builtins = value.find(
		(t) => t && typeof t === "object" && (t as Record<string, unknown>).type === "agent_toolset_20260401",
	) as Record<string, unknown> | undefined;
	if (!builtins) return undefined;

	const enabled = builtins.enabled_tools;
	if (!Array.isArray(enabled)) return undefined;

	const normalized = enabled
		.filter((t): t is string => typeof t === "string")
		.map((t) => normalizeToolNameFromQoder(t));

	return normalized.length ? { builtin: normalized } : undefined;
}

function normalizeQoderMcpServers(value: unknown): unknown {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	return value.map((s) => {
		const server = s as Record<string, unknown>;
		return compactDeep({
			name: server.name,
			type: server.type === "http" ? "http" : server.type,
			url: server.url,
		});
	});
}

async function buildSkillFormData(name: string, decl: SkillDecl, files: SkillFile[]): Promise<FormData> {
	const zip = new JSZip();
	for (const f of files) {
		zip.file(f.relativePath, f.content);
	}
	const zipContent = await zip.generateAsync({ type: "uint8array" });

	const formData = new FormData();
	formData.append(
		"file",
		new File([new Uint8Array(zipContent)], `${name}.zip`, {
			type: "application/zip",
		}),
	);
	formData.append("name", name);
	formData.append("type", "custom");
	if (decl.description) formData.append("description", decl.description);
	return formData;
}

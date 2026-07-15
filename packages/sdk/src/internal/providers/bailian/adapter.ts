import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import JSZip from "jszip";
import {
	classifyFileScan,
	classifySkillScan,
	FILE_SCAN_BACKOFF,
	pollUntil,
	SCAN_FILE_TIMEOUT_MS,
	SCAN_SKILL_TIMEOUT_MS,
	SKILL_SCAN_BACKOFF,
	skillStatusFromString,
} from "../../../scan-lifecycle.ts";
import { UserError } from "../../errors.ts";
import type {
	AgentDecl,
	CredentialDecl,
	DeploymentDecl,
	EnvironmentDecl,
	SkillDecl,
	VaultDecl,
} from "../../types/config.ts";
import type { CloudAgent, CloudEnvironment, CloudVault } from "../../types/dto.ts";
import type { ProviderFileInfo } from "../../types/file.ts";
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
import { compactDeep, stripAgentsMetadata } from "../../utils/comparable.ts";
import { toRemoteResource } from "../base-client.ts";
import type {
	ComparableRemoteResource,
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
import { extractCreatedEventId, listSessionEventsPaged } from "../session-event-response.ts";
import {
	buildSessionInfo,
	exportRemoteResources,
	locateRemote,
	toCloudAgent,
	toCloudEnvironment,
	toCloudVault,
	toRestFileInfo,
} from "../shared.ts";
import { BailianClient } from "./client.ts";
import {
	agentToDecl,
	envToDecl,
	fileToDecl,
	mapAgent,
	mapCredential,
	mapDeploymentToSession,
	mapEnvironment,
	mapInitialEvents,
	mapSendMessage,
	mapSession,
	mapVault,
	skillToDecl,
	toSessionEvent,
	vaultToDecl,
} from "./mapper.ts";

export class BailianAdapter implements ProviderAdapter {
	readonly name = "bailian" as const;
	readonly eventResume = false;
	private client: BailianClient;
	private projectName: string;

	constructor(apiKey: string, workspaceId: string, baseUrl?: string, projectName?: string) {
		this.client = new BailianClient({ apiKey, workspaceId, baseUrl });
		this.projectName = projectName ?? "";
	}

	async validate(): Promise<void> {
		await this.client.get("/agents?limit=1");
	}

	private static readonly ENDPOINT_MAP: Partial<Record<ResourceType, string>> = {
		environment: "/environments",
		agent: "/agents",
		skill: "/skills",
		vault: "/vaults",
		file: "/files",
	};

	async findResource(type: ResourceType, name: string, id?: string | null): Promise<RemoteResource | null> {
		const accept = type === "agent" ? (r: Record<string, unknown>) => !isArchivedAgent(r) : undefined;
		const raw = await locateRemote(this.client, BailianAdapter.ENDPOINT_MAP[type], name, id, accept);
		return raw ? toRemoteResource(raw) : null;
	}

	getDriftSupport(type: ResourceType): DriftSupport {
		if (type === "agent" || type === "environment") return "full";
		if (type === "skill" || type === "vault" || type === "file") return "existence";
		return "unsupported";
	}

	async readComparableResource(
		type: ResourceType,
		id: string | null,
		name: string,
	): Promise<ComparableRemoteResource | null> {
		if (type !== "agent" && type !== "environment") return null;
		const endpoint = type === "agent" ? "/agents" : "/environments";
		const accept = type === "agent" ? (r: Record<string, unknown>) => !isArchivedAgent(r) : undefined;
		const raw = await locateRemote(this.client, endpoint, name, id, accept);
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

		return compactDeep({
			description: raw.description,
			model: normalizeBailianModel(raw.model),
			instructions: raw.system,
			tools: normalizeBailianTools(raw.tools),
			mcp_servers: normalizeBailianMcpServers(raw.mcp_servers),
			metadata: stripAgentsMetadata(raw.metadata),
		});
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

	// --- Environment ---

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

	// --- Agent ---

	async createAgent(name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource> {
		const skillVersions = await this.fetchSkillVersions(refs);
		const body = mapAgent(name, decl, refs, undefined, this.projectName, skillVersions);
		const res = (await this.client.post("/agents", body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async updateAgent(id: string, name: string, decl: AgentDecl, refs: ResolvedAgentRefs): Promise<RemoteResource> {
		const current = (await this.client.get(`/agents/${id}`)) as {
			version: number;
		};
		const skillVersions = await this.fetchSkillVersions(refs);
		const body = mapAgent(name, decl, refs, current.version, this.projectName, skillVersions);
		const res = (await this.client.post(`/agents/${id}`, body)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	private async fetchSkillVersions(refs: ResolvedAgentRefs): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const s of refs.skill_ids) {
			if (s.version) {
				out[s.skill_id] = s.version;
				continue;
			}
			try {
				// Prefer the most recent ACTIVE version. /skills/{id} returns
				// `latest_version` regardless of scan status; if that version is
				// still in `security_scanning`, the agent create call fails with
				// AGENT_010.
				const list = (await this.client.get(`/skills/${s.skill_id}/versions`)) as {
					data?: Array<{
						version: string;
						status?: string;
						created_at?: string;
					}>;
				};
				console.log(
					`[agent-skill] GET /skills/${s.skill_id}/versions:`,
					JSON.stringify(list.data?.map((v) => ({ version: v.version, status: v.status }))),
				);
				const active = (list.data ?? [])
					.filter((v) => v.status === "active")
					.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
				if (active[0]?.version) {
					out[s.skill_id] = active[0].version;
					console.log(`[agent-skill] Using active version ${active[0].version} for skill ${s.skill_id}`);
					continue;
				}
				const detail = (await this.client.get(`/skills/${s.skill_id}`)) as {
					latest_version?: string;
				};
				console.log(`[agent-skill] No active version found, latest_version=${detail.latest_version}`);
				if (detail.latest_version) out[s.skill_id] = detail.latest_version;
			} catch (err) {
				// Best effort — fall back to default version in mapper.
				console.log(
					`[agent-skill] Error fetching versions for skill ${s.skill_id}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		return out;
	}

	async deleteAgent(id: string): Promise<void> {
		await this.client.post(`/agents/${id}/archive`, {});
	}

	// --- Skill (2-step: Files API → Skills API) ---

	async createSkill(name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const fileId = await this.uploadSkillZip(name, decl, files);
		await this.waitForFileAvailable(fileId);
		const res = (await this.postSkillWithRetry({ file_id: fileId })) as Record<string, unknown>;
		const skillId = res.id as string;
		const version = res.latest_version as string | undefined;
		if (skillId && version) {
			await this.waitForSkillVersionActive(name, skillId, version);
		}
		return toRemoteResource(res);
	}

	// Bailian's /files upload returns 200 before OSS replication completes, so
	// the first /skills call after a fresh upload often errors with
	// SKILL_FILE_NOT_FOUND. Retry with exponential backoff before giving up.
	private async postSkillWithRetry(body: { file_id: string }): Promise<unknown> {
		const delays = [1000, 2000, 4000, 8000];
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.client.post("/skills", body);
			} catch (err) {
				const isFileNotReady = err instanceof Error && /SKILL_FILE_NOT_FOUND/.test(err.message);
				if (!isFileNotReady || attempt >= delays.length) throw err;
				console.log(
					`[skill-upload] /skills SKILL_FILE_NOT_FOUND, retry ${attempt + 1}/${delays.length} after ${delays[attempt]}ms (file_id=${body.file_id})`,
				);
				await new Promise((r) => setTimeout(r, delays[attempt]));
			}
		}
	}

	async updateSkill(id: string, name: string, decl: SkillDecl, files: SkillFile[]): Promise<RemoteResource> {
		const fileId = await this.uploadSkillZip(name, decl, files);
		await this.waitForFileAvailable(fileId);
		const res = (await this.postSkillVersionWithRetry(id, {
			file_id: fileId,
		})) as Record<string, unknown>;
		// SkillVersionDTO uses `skill_id` instead of `id`
		const skillId = (res.skill_id as string) ?? id;
		const version = res.version as string | undefined;
		if (skillId && version) {
			await this.waitForSkillVersionActive(name, skillId, version);
		}
		return { id: skillId, type: "skill" };
	}

	// Newly created/updated skill versions are admitted in `security_scanning`
	// status; downstream agent creation that references the skill will fail with
	// AGENT_010 until the scan finishes. Poll the version endpoint until it
	// becomes `active`. Terminal failure states short-circuit immediately.
	private async waitForSkillVersionActive(name: string, skillId: string, version: string): Promise<void> {
		await pollUntil<string>({
			poll: async () => {
				const detail = (await this.client.get(`/skills/${skillId}/versions/${version}`)) as { status?: string };
				return detail.status ?? "security_scanning";
			},
			classify: (status) => classifySkillScan(skillStatusFromString(status)),
			timeoutMs: SCAN_SKILL_TIMEOUT_MS,
			interval: SKILL_SCAN_BACKOFF,
			onFailed: (status) =>
				new UserError(`Skill ${name}@${version} entered terminal status "${status}" during security scan`),
			onTimeout: (last) =>
				new UserError(
					`Skill ${name}@${version} did not become active within ${SCAN_SKILL_TIMEOUT_MS / 1000}s (last status: ${last ?? "security_scanning"}). The scan may still complete shortly; rerun apply later.`,
				),
		});
	}

	// A freshly uploaded file lands in `checking` while content audit runs (observed ~15s).
	// Downstream binding rejects any file that isn't `available`: /skills and /skills/{id}/versions
	// fail with SKILL_FILE_NOT_FOUND (HTTP 500), and session bindSessionFiles fails with "源文件不可用".
	// Poll the Files API to `available` before using it. Terminal rejection short-circuits.
	private async waitForFileAvailable(fileId: string): Promise<void> {
		await pollUntil<string | undefined>({
			poll: async () => (await this.getFileInfo(fileId)).status,
			classify: classifyFileScan,
			timeoutMs: SCAN_FILE_TIMEOUT_MS,
			interval: FILE_SCAN_BACKOFF,
			onFailed: (status) => new UserError(`File entered terminal status "${status}" during content audit`),
			onTimeout: (last) =>
				new UserError(
					`File did not become available within ${SCAN_FILE_TIMEOUT_MS / 1000}s (last status: ${last ?? "unknown"})`,
				),
		});
	}

	private async postSkillVersionWithRetry(id: string, body: { file_id: string }): Promise<unknown> {
		const delays = [1000, 2000, 4000, 8000];
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.client.post(`/skills/${id}/versions`, body);
			} catch (err) {
				const isFileNotReady = err instanceof Error && /SKILL_FILE_NOT_FOUND/.test(err.message);
				if (!isFileNotReady || attempt >= delays.length) throw err;
				await new Promise((r) => setTimeout(r, delays[attempt]));
			}
		}
	}

	async deleteSkill(id: string): Promise<void> {
		await this.client.delete(`/skills/${id}`);
	}

	async listSkills(source?: "custom" | "official"): Promise<ProviderSkillInfo[]> {
		// GET /skills defaults to the workspace custom catalog (source=customer). The official
		// built-in catalog is a separate page that must be requested explicitly with ?source=official.
		const path = source === "official" ? "/skills?source=official" : "/skills";
		const all = await this.client.getAllPaged(path);
		return all.map(toBailianSkillInfo);
	}

	async getSkillInfo(id: string): Promise<ProviderSkillInfo> {
		const res = (await this.client.get(`/skills/${id}`)) as Record<string, unknown>;
		return toBailianSkillInfo(res);
	}

	// Non-blocking create: file already uploaded → POST /skills with retry for residual OSS
	// replication lag (postSkillWithRetry covers SKILL_FILE_NOT_FOUND for a few seconds), and return
	// the initial status WITHOUT waiting for the security scan. Callers MUST ensure the file has
	// cleared content audit (status `available`) first — the webui's two-phase upload polls file
	// status before calling this. The webui then polls getSkillInfo until active. Contrast createSkill,
	// which also blocks up to 180s via waitForSkillVersionActive (used by agents apply, not the webui).
	async createSkillFromFileId(fileId: string): Promise<ProviderSkillInfo> {
		const res = (await this.postSkillWithRetry({ file_id: fileId })) as Record<string, unknown>;
		return toBailianSkillInfo(res);
	}

	private async uploadSkillZip(name: string, _decl: SkillDecl, files: SkillFile[]): Promise<string> {
		const zip = new JSZip();
		for (const f of files) {
			zip.file(f.relativePath, f.content);
		}
		const zipContent = await zip.generateAsync({ type: "uint8array" });

		console.log(
			`[skill-upload] Uploading ZIP for "${name}" (${zipContent.byteLength} bytes, ${files.length} file(s): ${files.map((f) => f.relativePath).join(", ")})`,
		);

		const formData = new FormData();
		// NOTE: do not set the File constructor's `type: "application/zip"`.
		// Bailian's /skills endpoint validates the uploaded file's mime_type and
		// only accepts application/octet-stream; setting application/zip causes
		// /skills to fail with SKILL_FILE_NOT_FOUND even though the upload itself
		// returned 200.
		formData.append("file", new File([new Uint8Array(zipContent)], `${name}.zip`));
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		console.log(`[skill-upload] /files response:`, JSON.stringify(res));

		const fileId = res.id as string;

		// Wait for file to be ready before calling /skills.
		// The /files API returns status="checking" initially; poll until it changes.
		await this.waitForFileReady(fileId);

		return fileId;
	}

	private async waitForFileReady(fileId: string): Promise<void> {
		// Lenient pre-skill-upload wait: unlike waitForFileAvailable (which throws), this proceeds
		// anyway on timeout. Timeout/backoff come from the shared scan-lifecycle module so they can't
		// drift from the strict waiters.
		const start = Date.now();
		let delay = FILE_SCAN_BACKOFF.initial;
		let logged = false;

		while (true) {
			const detail = (await this.client.get(`/files/${fileId}`)) as Record<string, unknown>;
			const status = (detail.status as string) ?? "checking";

			if (status !== "checking") {
				console.log(`[skill-upload] File ${fileId} ready (status=${status})`);
				return;
			}

			if (!logged) {
				console.log(`[skill-upload] File ${fileId} is being checked, waiting...`);
				logged = true;
			}

			if (Date.now() - start >= SCAN_FILE_TIMEOUT_MS) {
				console.log(
					`[skill-upload] File ${fileId} still "checking" after ${SCAN_FILE_TIMEOUT_MS / 1000}s, proceeding anyway`,
				);
				return;
			}

			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * FILE_SCAN_BACKOFF.factor, FILE_SCAN_BACKOFF.max);
		}
	}

	// --- Vault (Vaults API) ---
	//
	// `createVault` / `deleteVault` satisfy the cross-provider ProviderAdapter
	// contract. The remaining vault + credential methods below are Bailian-only
	// thin wrappers over the AgentStudio endpoints, exposed so callers/tests can
	// exercise the full surface through real project code rather than raw fetch.

	async createVault(name: string, decl: VaultDecl): Promise<RemoteResource> {
		const body = mapVault(name, decl, this.projectName);
		const res = (await this.client.post("/vaults", body)) as Record<string, unknown>;
		const vaultId = res.id as string;

		for (const cred of decl.credentials ?? []) {
			await this.createCredential(vaultId, cred);
		}

		return toRemoteResource(res);
	}

	async listVaults(_filter?: { limit?: number }): Promise<CloudVault[]> {
		const all = await this.client.getAllPaged("/vaults");
		return all.map(toCloudVault);
	}

	async getVault(id: string): Promise<Record<string, unknown>> {
		return (await this.client.get(`/vaults/${id}`)) as Record<string, unknown>;
	}

	async updateVault(
		id: string,
		patch: { display_name?: string; metadata?: Record<string, string> },
	): Promise<RemoteResource> {
		const res = (await this.client.post(`/vaults/${id}`, patch)) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async archiveVault(id: string): Promise<RemoteResource> {
		const res = (await this.client.post(`/vaults/${id}/archive`, {})) as Record<string, unknown>;
		return toRemoteResource(res);
	}

	async deleteVault(id: string): Promise<void> {
		await this.client.delete(`/vaults/${id}`);
	}

	// --- Credentials API (nested under a vault) ---

	async createCredential(vaultId: string, cred: CredentialDecl): Promise<RemoteResource> {
		const res = (await this.client.post(`/vaults/${vaultId}/credentials`, mapCredential(cred))) as Record<
			string,
			unknown
		>;
		return toRemoteResource(res);
	}

	async listCredentials(vaultId: string): Promise<RemoteResource[]> {
		const all = await this.client.getAllPaged(`/vaults/${vaultId}/credentials`);
		return all.map(toRemoteResource);
	}

	async getCredential(vaultId: string, credentialId: string): Promise<Record<string, unknown>> {
		return (await this.client.get(`/vaults/${vaultId}/credentials/${credentialId}`)) as Record<string, unknown>;
	}

	async updateCredential(
		vaultId: string,
		credentialId: string,
		patch: { display_name?: string; metadata?: Record<string, string> },
	): Promise<RemoteResource> {
		const res = (await this.client.post(`/vaults/${vaultId}/credentials/${credentialId}`, patch)) as Record<
			string,
			unknown
		>;
		return toRemoteResource(res);
	}

	async archiveCredential(vaultId: string, credentialId: string): Promise<RemoteResource> {
		const res = (await this.client.post(`/vaults/${vaultId}/credentials/${credentialId}/archive`, {})) as Record<
			string,
			unknown
		>;
		return toRemoteResource(res);
	}

	async deleteCredential(vaultId: string, credentialId: string): Promise<void> {
		await this.client.delete(`/vaults/${vaultId}/credentials/${credentialId}`);
	}

	// --- Deployment (emulated) ---

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

		const eventsBody = mapInitialEvents(ctx.decl.initial_events);
		const input = (eventsBody as { input: unknown[] }).input;
		if (input.length) {
			await this.client.post(`/sessions/${sessionId}/events`, eventsBody);
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
		const res = (await this.client.postFormData("/files", formData)) as Record<string, unknown>;
		const fileId = res.id as string;
		// A fresh upload lands in `checking` while content audit runs; binding it to the
		// session (bindSessionFiles) rejects an unavailable source with "源文件不可用". Wait
		// for `available` before materializing the session, mirroring the skill path.
		await this.waitForFileAvailable(fileId);
		return fileId;
	}

	// --- Session ---

	async createSession(bindings: SessionBindings): Promise<ProviderSessionInfo> {
		const body = mapSession(bindings);
		const res = (await this.client.post("/sessions", body)) as Record<string, unknown>;
		return toSessionInfo(res);
	}

	async listAgents(filter?: { prefix?: string; limit?: number }): Promise<CloudAgent[]> {
		// The `/agents` `keyword` param is a no-op on this API (verified live: it
		// returns the full, unfiltered page), and the org routinely exceeds one
		// page. So a prefix request must scan EVERY page and filter locally —
		// otherwise family members that happen to land on page 2+ silently vanish
		// from the resource center.
		const prefix = filter?.prefix;
		if (prefix) {
			// Include archived agents. The resource center scopes a session's visibility by its
			// owning agent's id, and archive is a SOFT delete — the cloud keeps the agent's
			// sessions. Listing active-only would drop every session owned by an archived agent
			// from the view (an archived agent still belongs to the family). The caller
			// partitions active vs archived locally via `archived_at`.
			const all = await this.client.getAllPaged("/agents?include_archived=true");
			return all.map(toCloudAgent).filter((a) => (a.name ?? "").startsWith(prefix));
		}
		const res = (await this.client.get(`/agents?limit=${filter?.limit ?? 100}`)) as {
			data?: Record<string, unknown>[];
		};
		return (res.data ?? []).map(toCloudAgent);
	}

	async listEnvironments(_filter?: { limit?: number }): Promise<CloudEnvironment[]> {
		// The org exceeds one page (verified live: 121 across 2 pages), so a single
		// `?limit=100` page silently drops environments from the resource center.
		const all = await this.client.getAllPaged("/environments");
		return all.map(toCloudEnvironment);
	}

	async listSessions(filter?: SessionFilter): Promise<SessionListResult> {
		const params = new URLSearchParams();
		if (filter?.agent_id) params.set("agent_id", filter.agent_id);
		if (filter?.limit) params.set("limit", String(filter.limit));
		if (filter?.page) params.set("page", filter.page);
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
		// AGENTSTUDIO's stream pushes only post-connect events and accepts no cursor
		// param; reconnection is done by replaying history via listSessionEvents and
		// de-duplicating by event id, so `after_id` is intentionally not forwarded.
		for await (const raw of this.client.sse(`/sessions/${sessionId}/events/stream`)) {
			yield toSessionEvent(raw);
		}
	}

	async listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList> {
		// AGENTSTUDIO silently ignores the Agents-style `after_id` resume marker (returns
		// http 200 with the full unfiltered list rather than rejecting), so forwarding it
		// buys nothing; it is never sent (mirrors claude). Shared page-cursor handling
		// lives in listSessionEventsPaged.
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
		const mimeType = options?.mimeType || guessMimeType(filename);
		const formData = new FormData();
		formData.append("file", new File([new Uint8Array(content)], filename, { type: mimeType }));
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

function isArchivedAgent(raw: Record<string, unknown>): boolean {
	return typeof raw.archived_at === "string" && raw.archived_at.trim().length > 0;
}

export function toSessionInfo(res: Record<string, unknown>): ProviderSessionInfo {
	return buildSessionInfo(res, () => []);
}

// Raw Bailian `/skills` item → neutral ProviderSkillInfo. Kept provider-local (not the
// shared toRestSkillInfo) because bailian's wire differs: name is `name` (not display_title),
// the custom catalog reports `customer`, and skills carry a real security-scan status.
export function toBailianSkillInfo(res: Record<string, unknown>): ProviderSkillInfo {
	const rawSource = String(res.source ?? "").toLowerCase();
	const source = rawSource === "customer" ? "custom" : "official";
	return {
		id: res.id as string,
		name: (res.name as string) ?? "",
		description: res.description as string | undefined,
		source,
		status: skillStatusFromString(res.status),
		latest_version: res.latest_version as string | undefined,
		created_at: res.created_at as string | undefined,
		updated_at: res.updated_at as string | undefined,
	};
}

function normalizeBailianModel(value: unknown): unknown {
	if (value && typeof value === "object" && "id" in value) {
		return (value as Record<string, unknown>).id;
	}
	return value;
}

function normalizeBailianTools(value: unknown): unknown {
	if (!Array.isArray(value)) return undefined;
	const builtins = value.find(
		(t) => t && typeof t === "object" && (t as Record<string, unknown>).type === "builtin_toolkit",
	) as Record<string, unknown> | undefined;
	if (!builtins) return undefined;

	const configs = builtins.configs;
	if (!Array.isArray(configs)) return undefined;
	const enabled = configs
		.map((c) => c as Record<string, unknown>)
		.filter((c) => c.enabled !== false && typeof c.name === "string")
		.map((c) => c.name as string);

	return enabled.length ? { builtin: enabled } : undefined;
}

function normalizeBailianMcpServers(value: unknown): unknown {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	return value.map((s) => {
		const server = s as Record<string, unknown>;
		return compactDeep({
			name: server.name,
			type: server.type,
			url: server.url,
		});
	});
}

const MIME_MAP: Record<string, string> = {
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".htm": "text/html",
	".md": "text/markdown",
	".yaml": "text/yaml",
	".yml": "text/yaml",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".js": "application/javascript",
	".ts": "text/x-typescript",
	".py": "text/x-python",
	".css": "text/css",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMimeType(fileName: string): string {
	const ext = extname(fileName).toLowerCase();
	return MIME_MAP[ext] ?? "application/octet-stream";
}

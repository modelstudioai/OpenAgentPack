import { defaultFileUploadPurpose, enrichProviderFileInfo } from "../../file-lifecycle.ts";
import { UserError } from "../errors.ts";
import type { SessionCreateOptions } from "../session/session-manager.ts";
import { buildSessionBindings, resolveSessionProvider } from "../session/session-manager.ts";
import type { ProviderFileInfo } from "../types/file.ts";
import type { ProviderSessionInfo, SessionBindings, SessionFilter, SessionListResult } from "../types/session.ts";
import type {
	EventListOptions,
	EventStreamOptions,
	ProviderSessionEvent,
	ProviderSessionEventList,
} from "../types/session-event.ts";
import type { ProviderSkillInfo } from "../types/skill-info.ts";
import { preparePromptForProvider } from "../utils/sandbox-mount.ts";
import { resolveAgentMaterialization } from "./agent-materialization.ts";
import type { ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider } from "./project-runtime.ts";

export interface SessionWorkflowAdapter {
	readonly name: string;
	/**
	 * Whether `sendSessionMessage` returns an event-id cursor the stream/poll can
	 * resume after. true → send-then-stream with `afterId`; false → connect-before-send.
	 */
	readonly eventResume: boolean;
	createSession(bindings: SessionBindings): Promise<ProviderSessionInfo>;
	listSessions(filter?: SessionFilter): Promise<SessionListResult>;
	getSession(id: string): Promise<ProviderSessionInfo>;
	deleteSession(id: string): Promise<void>;
	sendSessionMessage(sessionId: string, message: string): Promise<string | undefined>;
	streamSessionEvents(sessionId: string, options?: EventStreamOptions): AsyncIterable<ProviderSessionEvent>;
	listSessionEvents(sessionId: string, options?: EventListOptions): Promise<ProviderSessionEventList>;
}

export interface SessionFileAdapter {
	uploadFileContent(
		content: Uint8Array,
		filename: string,
		options?: { mimeType?: string; purpose?: string },
	): Promise<ProviderFileInfo>;
	deleteFile(id: string): Promise<void>;
	getFileInfo?(id: string): Promise<ProviderFileInfo>;
	getFileDownloadUrl?(id: string): Promise<{ url: string; expires_at?: string }>;
	listFiles?(): Promise<ProviderFileInfo[]>;
}

export interface SessionSkillAdapter {
	deleteSkill(id: string): Promise<void>;
	listSkills?(source?: "custom" | "official"): Promise<ProviderSkillInfo[]>;
	getSkillInfo?(id: string): Promise<ProviderSkillInfo>;
	createSkillFromFileId?(fileId: string): Promise<ProviderSkillInfo>;
}

export type SessionRuntimeAdapter = SessionWorkflowAdapter & SessionFileAdapter & SessionSkillAdapter;

export interface SessionRuntimeTarget {
	agent?: string;
	provider?: string;
}

export interface SessionRuntimeCreateOptions extends SessionCreateOptions, SessionRuntimeTarget {}

export interface SessionRuntimeRunOptions extends SessionRuntimeCreateOptions {
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
}

export interface SessionRuntimeSendOptions extends SessionRuntimeTarget {
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
}

export interface ResolvedSessionRuntime {
	agentName: string;
	provider: string;
	adapter: SessionWorkflowAdapter;
}

export interface CreatedSessionRun {
	agentName: string;
	provider: string;
	session: ProviderSessionInfo;
}

export interface StreamingSessionRun extends CreatedSessionRun {
	events: AsyncIterable<ProviderSessionEvent>;
}

export interface CollectedSessionEvents {
	eventId?: string;
	terminalStatus: string;
	result: ProviderSessionEventList;
}

export interface SessionSummary {
	session: ProviderSessionInfo;
	provider: string;
	agentId?: string;
	agentName?: string;
}

export interface SessionSummaryList {
	provider: string;
	summaries: SessionSummary[];
	hasMore: boolean;
	nextPage?: string;
}

const TERMINAL_SESSION_STATUSES = new Set(["idle", "completed", "failed", "terminated", "deleted"]);

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveAgentName(agents: Record<string, unknown> | undefined, agentName?: string): string {
	if (agentName) return agentName;
	const names = Object.keys(agents ?? {});
	if (names.length === 1) return names[0]!;
	if (names.length === 0) {
		throw new UserError("No agents defined in config.");
	}
	throw new UserError(`Multiple agents configured: ${names.join(", ")}. Use --agent to specify one.`);
}

export function isTerminalSessionStatus(status: string | undefined): boolean {
	return status !== undefined && TERMINAL_SESSION_STATUSES.has(status);
}

export function resolveSessionRuntime(
	ctx: ProjectRuntimeContext,
	target: SessionRuntimeTarget = {},
): ResolvedSessionRuntime {
	const agentName = resolveAgentName(ctx.config.agents as Record<string, unknown> | undefined, target.agent);
	const provider = resolveSessionProvider(agentName, ctx.config, target.provider);
	const adapter = getRuntimeProvider(ctx, provider);
	return { agentName, provider, adapter };
}

export async function createSessionForAgent(
	ctx: ProjectRuntimeContext,
	options: SessionRuntimeCreateOptions = {},
): Promise<CreatedSessionRun> {
	const { agentName, provider, adapter } = resolveSessionRuntime(ctx, options);
	const bindings = buildSessionBindings(agentName, ctx.config, provider, ctx.state, {
		identityId: options.identityId,
		environment: options.environment,
		environmentId: options.environmentId,
		tunnel: options.tunnel,
		tunnelId: options.tunnelId,
		vault: options.vault,
		vaultIds: options.vaultIds,
		memoryStores: options.memoryStores,
		files: options.files,
		title: options.title,
		metadata: options.metadata,
	});
	const session = await adapter.createSession(bindings);
	return { agentName, provider, session };
}

export async function startSessionRun(
	ctx: ProjectRuntimeContext,
	prompt: string,
	options: SessionRuntimeRunOptions = {},
): Promise<StreamingSessionRun> {
	const { agentName, provider, adapter } = resolveSessionRuntime(ctx, options);
	const bindings = buildSessionBindings(agentName, ctx.config, provider, ctx.state, {
		identityId: options.identityId,
		environment: options.environment,
		environmentId: options.environmentId,
		tunnel: options.tunnel,
		tunnelId: options.tunnelId,
		vault: options.vault,
		vaultIds: options.vaultIds,
		memoryStores: options.memoryStores,
		files: options.files,
		title: options.title,
		metadata: options.metadata,
	});
	const session = await adapter.createSession(bindings);
	return {
		agentName,
		provider,
		session,
		events: streamMessageEvents(adapter, session.id, preparePromptForProvider(prompt, bindings.files, provider)),
	};
}

export function streamMessageEvents(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	message: string,
): AsyncIterable<ProviderSessionEvent> {
	if (adapter.eventResume) {
		return streamWithResume(adapter, sessionId, message);
	}
	return streamConnectBeforeSend(adapter, sessionId, message);
}

export async function sendSessionMessageStreaming(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	message: string,
	options: SessionRuntimeSendOptions = {},
): Promise<AsyncIterable<ProviderSessionEvent>> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	return streamMessageEvents(adapter, sessionId, message);
}

export async function startSessionRunPolling(
	ctx: ProjectRuntimeContext,
	prompt: string,
	options: SessionRuntimeRunOptions = {},
): Promise<CreatedSessionRun & CollectedSessionEvents> {
	const run = await createSessionForAgent(ctx, options);
	const adapter = getRuntimeProvider(ctx, run.provider);
	const hintedPrompt = preparePromptForProvider(
		prompt,
		options.files?.map((f) => ({ mount_path: f.mountPath })),
		run.provider,
	);
	const collected = await sendSessionMessageAndCollectEvents(adapter, run.session.id, hintedPrompt, options);
	return { ...run, ...collected };
}

export async function sendSessionMessageAndCollectEvents(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	message: string,
	options: SessionRuntimeSendOptions = {},
): Promise<CollectedSessionEvents> {
	const eventId = await adapter.sendSessionMessage(sessionId, message);
	return collectEventsUntilTerminal(adapter, sessionId, {
		afterId: adapter.eventResume ? eventId : undefined,
		pollIntervalMs: options.pollIntervalMs,
		pollTimeoutMs: options.pollTimeoutMs,
	}).then((result) => ({ eventId, ...result }));
}

export async function sendSessionMessagePolling(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	message: string,
	options: SessionRuntimeSendOptions = {},
): Promise<CollectedSessionEvents> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	return sendSessionMessageAndCollectEvents(adapter, sessionId, message, options);
}

export async function collectEventsUntilTerminal(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	options: {
		afterId?: string;
		pollIntervalMs?: number;
		pollTimeoutMs?: number;
	} = {},
): Promise<Omit<CollectedSessionEvents, "eventId">> {
	const start = Date.now();
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	let terminalStatus = "idle";
	let result: ProviderSessionEventList | undefined;

	if (options.afterId) {
		while (true) {
			assertNotTimedOut(start, pollTimeoutMs);
			result = await adapter.listSessionEvents(sessionId, {
				limit: 100,
				after_id: options.afterId,
			});
			const terminalEvent = result.events.find(
				(event) => event.type === "status" && isTerminalSessionStatus(event.status),
			);
			if (terminalEvent?.status) {
				terminalStatus = terminalEvent.status;
				break;
			}
			await delay(pollIntervalMs);
		}
	} else {
		while (true) {
			assertNotTimedOut(start, pollTimeoutMs);
			const session = await adapter.getSession(sessionId);
			if (isTerminalSessionStatus(session.status)) {
				terminalStatus = session.status;
				break;
			}
			await delay(pollIntervalMs);
		}

		result = await adapter.listSessionEvents(sessionId, { limit: 100 });
	}

	return { terminalStatus, result };
}

export async function listSessionsForProject(
	ctx: ProjectRuntimeContext,
	options: SessionRuntimeTarget & { filter?: SessionFilter } = {},
): Promise<{
	provider: string;
	adapter: SessionWorkflowAdapter;
	agentId?: string;
	agentName?: string;
	result: Awaited<ReturnType<SessionWorkflowAdapter["listSessions"]>>;
}> {
	let provider: string;
	let agentId: string | undefined;
	let agentName: string | undefined;

	if (options.agent) {
		const resolved = resolveSessionRuntime(ctx, options);
		provider = resolved.provider;
		agentName = resolved.agentName;
		const agentDecl = ctx.config.agents?.[resolved.agentName];
		const resourceType = agentDecl ? resolveAgentMaterialization(provider, agentDecl).resourceType : "agent";
		const state = ctx.state.getResource({
			type: resourceType,
			name: resolved.agentName,
			provider,
		});
		if (!state?.remote_id) {
			throw new UserError(
				`${resourceType === "template" ? "Template" : "Agent"} '${resolved.agentName}' not found in state. Run \`agents apply\` first.`,
			);
		}
		agentId = state.remote_id;
	} else if (options.provider) {
		provider = options.provider;
	} else {
		const providers = Object.keys(ctx.config.providers);
		if (providers.length === 1) {
			provider = providers[0]!;
		} else {
			throw new UserError("Multiple providers configured. Use --provider to specify one.");
		}
	}

	const adapter = getRuntimeProvider(ctx, provider);
	const result = await adapter.listSessions(agentId ? { ...options.filter, agent_id: agentId } : options.filter);
	return { provider, adapter, agentId, agentName, result };
}

export async function listSessionSummaries(
	ctx: ProjectRuntimeContext,
	options: SessionRuntimeTarget & { filter?: SessionFilter } = {},
): Promise<SessionSummaryList> {
	const listed = await listSessionsForProject(ctx, options);
	const agentNames = buildAgentNameByRemoteId(ctx, listed.provider);
	return {
		provider: listed.provider,
		hasMore: listed.result.has_more,
		nextPage: listed.result.next_page,
		summaries: listed.result.sessions.map((session) => {
			const agentName = listed.agentName ?? agentNames.get(session.agent_id);
			return {
				session,
				provider: listed.provider,
				agentId: session.agent_id,
				agentName,
			};
		}),
	};
}

export async function getSession(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	provider?: string,
): Promise<ProviderSessionInfo> {
	return resolveDirectAdapter(ctx, provider).getSession(sessionId);
}

export async function deleteSession(ctx: ProjectRuntimeContext, sessionId: string, provider?: string): Promise<void> {
	await resolveDirectAdapter(ctx, provider).deleteSession(sessionId);
}

export async function listSessionEvents(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	options: SessionRuntimeTarget & { limit?: number; order?: string; page_token?: string; page?: string } = {},
): Promise<ProviderSessionEventList> {
	const listOptions: EventListOptions = {};
	if (options.limit !== undefined) listOptions.limit = options.limit;
	if (options.order !== undefined) listOptions.order = options.order;
	const pageToken = options.page_token ?? options.page;
	if (pageToken !== undefined) listOptions.page_token = pageToken;
	return resolveDirectAdapter(ctx, options.provider).listSessionEvents(
		sessionId,
		Object.keys(listOptions).length > 0 ? listOptions : undefined,
	);
}

/**
 * Upload a file's raw bytes to the resolved provider's Files API and return its metadata.
 * Content-based (no filesystem) so server contexts can forward browser uploads directly.
 */
export async function uploadFile(
	ctx: ProjectRuntimeContext,
	content: Uint8Array,
	filename: string,
	options: SessionRuntimeTarget & { mimeType?: string; purpose?: string } = {},
): Promise<ProviderFileInfo & { available: boolean }> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	const purpose = options.purpose ?? defaultFileUploadPurpose(adapter.name);
	const info = await adapter.uploadFileContent(content, filename, {
		mimeType: options.mimeType,
		purpose,
	});
	return enrichProviderFileInfo(adapter.name, info);
}

/** Delete a previously uploaded file by id from the resolved provider's Files API. */
export async function deleteFile(
	ctx: ProjectRuntimeContext,
	id: string,
	options: SessionRuntimeTarget = {},
): Promise<void> {
	await resolveDirectAdapter(ctx, options.provider).deleteFile(id);
}

/** Fetch a single file's metadata (incl. scan `status`), to gate session binding on availability. */
export async function getFileInfo(
	ctx: ProjectRuntimeContext,
	id: string,
	options: SessionRuntimeTarget = {},
): Promise<ProviderFileInfo & { available: boolean }> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.getFileInfo) throw new UserError("Provider does not support file metadata lookup");
	const info = await adapter.getFileInfo(id);
	return enrichProviderFileInfo(adapter.name, info);
}

/** Resolve a short-lived presigned download URL for a file (e.g. an agent-delivered artifact). */
export async function getFileDownloadUrl(
	ctx: ProjectRuntimeContext,
	id: string,
	options: SessionRuntimeTarget = {},
): Promise<{ url: string; expires_at?: string }> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.getFileDownloadUrl) throw new UserError("Provider does not support file downloads");
	return adapter.getFileDownloadUrl(id);
}

/** List workspace user-uploaded files (newest first) from the resolved provider's Files API.
 * Returns [] when the provider lacks file listing (graceful degradation, mirrors cloud listing). */
export async function listFiles(
	ctx: ProjectRuntimeContext,
	options: SessionRuntimeTarget = {},
): Promise<Array<ProviderFileInfo & { available: boolean }>> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.listFiles) return [];
	const all = await adapter.listFiles();
	return all.map((info) => enrichProviderFileInfo(adapter.name, info));
}

/** List skills (newest first) from the resolved provider's Skills API. `source` selects the
 * catalog: "custom" (workspace-uploaded, the default) or "official" (the built-in catalog).
 * Returns [] when the provider lacks skill listing (graceful degradation, mirrors cloud listing). */
export async function listSkills(
	ctx: ProjectRuntimeContext,
	options: SessionRuntimeTarget & { source?: "custom" | "official" } = {},
): Promise<ProviderSkillInfo[]> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.listSkills) return [];
	return adapter.listSkills(options.source);
}

/** Fetch a single skill's metadata (incl. scan `status`), to poll create → active. */
export async function getSkillInfo(
	ctx: ProjectRuntimeContext,
	id: string,
	options: SessionRuntimeTarget = {},
): Promise<ProviderSkillInfo> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.getSkillInfo) throw new UserError("Provider does not support skill metadata lookup");
	return adapter.getSkillInfo(id);
}

/** Create a skill from an uploaded zip's file_id (non-blocking; returns initial scan status). */
export async function createSkillFromFileId(
	ctx: ProjectRuntimeContext,
	fileId: string,
	options: SessionRuntimeTarget = {},
): Promise<ProviderSkillInfo> {
	const adapter = resolveDirectAdapter(ctx, options.provider);
	if (!adapter.createSkillFromFileId) throw new UserError("Provider does not support skill creation");
	return adapter.createSkillFromFileId(fileId);
}

/** Delete a custom skill by id from the resolved provider's Skills API. */
export async function deleteSkill(
	ctx: ProjectRuntimeContext,
	id: string,
	options: SessionRuntimeTarget = {},
): Promise<void> {
	await resolveDirectAdapter(ctx, options.provider).deleteSkill(id);
}

/**
 * Subscribe to a session's live event stream by id (native SSE). The underlying provider
 * stream pushes only post-connect events, so callers that need full history must replay it
 * via listSessionEvents and de-dupe by ProviderSessionEvent.id.
 */
export function streamSessionEvents(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	options: SessionRuntimeTarget & EventStreamOptions = {},
): AsyncIterable<ProviderSessionEvent> {
	const streamOptions: EventStreamOptions = {};
	if (options.after_id !== undefined) streamOptions.after_id = options.after_id;
	return resolveDirectAdapter(ctx, options.provider).streamSessionEvents(
		sessionId,
		Object.keys(streamOptions).length > 0 ? streamOptions : undefined,
	);
}

function resolveDirectAdapter(ctx: ProjectRuntimeContext, overrideProvider?: string): SessionRuntimeAdapter {
	if (overrideProvider) return getRuntimeProvider(ctx, overrideProvider);

	const keys = Array.from(ctx.providers.keys());
	if (keys.length === 1) return getRuntimeProvider(ctx, keys[0]!);
	throw new UserError("Multiple providers configured. Use --provider to specify one.");
}

function buildAgentNameByRemoteId(ctx: ProjectRuntimeContext, provider: string): Map<string, string> {
	const names = new Map<string, string>();
	for (const resource of ctx.state.listResources()) {
		if (
			(resource.address.type === "agent" || resource.address.type === "template") &&
			resource.address.provider === provider &&
			resource.remote_id
		) {
			names.set(resource.remote_id, resource.address.name);
		}
	}
	return names;
}

// Qoder: send first (returns event ID), then stream from that ID to avoid missing events.
async function* streamWithResume(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	message: string,
): AsyncIterable<ProviderSessionEvent> {
	const eventId = await adapter.sendSessionMessage(sessionId, message);
	yield* adapter.streamSessionEvents(sessionId, eventId ? { after_id: eventId } : undefined);
}

// Claude/Bailian: connect stream first, then send — provider pushes events immediately on send.
async function* streamConnectBeforeSend(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	message: string,
): AsyncIterable<ProviderSessionEvent> {
	const iterator = adapter.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
	let sent = false;
	try {
		while (true) {
			const next = iterator.next();
			if (!sent) {
				sent = true;
				await adapter.sendSessionMessage(sessionId, message);
			}
			const item = await next;
			if (item.done) return;
			yield item.value;
		}
	} finally {
		if (iterator.return) await iterator.return();
	}
}

function assertNotTimedOut(start: number, timeoutMs: number): void {
	if (Date.now() - start > timeoutMs) {
		throw new UserError(`Session did not complete within the timeout (${Math.floor(timeoutMs / 1000)} seconds).`);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

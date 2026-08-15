import {
	type AgentDefinition,
	type BackendRuntimeInput,
	createSessionForAgent,
	deleteSession,
	getFileDownloadUrl,
	getSession,
	isAgentRunnable,
	isTerminalSessionStatus,
	listSessionEvents,
	type ProviderSessionEvent,
	type ProviderSessionInfo,
	readProjectRuntime,
	type Session,
	sendSessionMessageStreaming,
	startSessionRun,
	streamSessionEvents,
} from "@openagentpack/sdk";
import { projectRuntimeManager } from "@/services/project-manager";
import { type AttachmentRecord, projectRuntimeRegistry } from "@/services/project-runtime-registry";
import { createEventBuffer, getEventBuffer, seedCompletedBuffer } from "@/services/sessions/event-buffer";

export async function startProjectSession(input: {
	agentId: string;
	prompt?: string;
	title?: string;
	attachmentIds?: string[];
}): Promise<{
	session: Session;
	provider: string;
	agent_id: string;
	agent_name: string;
	agent_details: AgentDefinition;
	events: ProviderSessionEvent[];
}> {
	const summary = await projectRuntimeManager.getSummary();
	const selected = summary.agents.find((entry) => entry.agent.id === input.agentId);
	if (!selected) throw statusError(`Agent '${input.agentId}' was not found in agents.yaml.`, 404);
	if (!isAgentRunnable(selected.readiness)) {
		throw statusError(
			`Agent '${input.agentId}' is not ready (${selected.readiness.status}). Review and apply its resource plan first.`,
			422,
		);
	}
	const runtime = projectRuntimeManager.requireRuntimeInput();
	const snapshot = projectRuntimeManager.getSnapshot();
	const attachments = await resolveAttachments(input.agentId, selected.agent.provider, input.attachmentIds ?? []);
	const options = {
		agent: input.agentId,
		title: input.title,
		files: attachments.map((attachment) => ({
			fileId: attachment.remote_file_id,
			mountPath: `/uploads/${safeFilename(attachment.filename)}`,
		})),
	};
	const prompt = input.prompt?.trim();
	let session: ProviderSessionInfo;
	let provider: string;
	if (prompt) {
		const run = await readProjectRuntime(runtime, (context) => startSessionRun(context, prompt, options));
		createEventBuffer(run.session.id, run.events);
		session = run.session;
		provider = run.provider;
	} else {
		const created = await readProjectRuntime(runtime, (context) => createSessionForAgent(context, options));
		seedCompletedBuffer(created.session.id, []);
		session = created.session;
		provider = created.provider;
	}
	await projectRuntimeRegistry.putSession({
		session_id: session.id,
		agent_id: input.agentId,
		provider,
		project_revision: snapshot.revision!,
		created_at: new Date().toISOString(),
		runtime,
	});
	return {
		session: toSession(session),
		provider,
		agent_id: input.agentId,
		agent_name: agentDisplayName(runtime, input.agentId),
		agent_details: sessionAgentDefinition(runtime, input.agentId, provider),
		events: [],
	};
}

export async function sendProjectSessionMessage(
	sessionId: string,
	message: string,
): Promise<{
	session: Session;
	provider: string;
	agent_id: string;
	agent_name: string;
	agent_details: AgentDefinition;
	events: ProviderSessionEvent[];
}> {
	const record = await requireSessionRecord(sessionId);
	const runtime = resolveSessionRuntime(record.runtime, record.agent_id, record.provider);
	const priorEvents = await listAllEvents(runtime, sessionId, record.provider);
	const stream = await readProjectRuntime(runtime, (context) =>
		sendSessionMessageStreaming(context, sessionId, message, {
			agent: record.agent_id,
			provider: record.provider,
		}),
	);
	createEventBuffer(sessionId, stream, priorEvents);
	const session = await readProjectRuntime(runtime, (context) => getSession(context, sessionId, record.provider));
	return {
		session: toSession(session),
		provider: record.provider,
		agent_id: record.agent_id,
		agent_name: agentDisplayName(runtime, record.agent_id),
		agent_details: sessionAgentDefinition(runtime, record.agent_id, record.provider),
		events: priorEvents,
	};
}

export async function getProjectSessionDetail(sessionId: string): Promise<{
	session: Session;
	provider: string;
	agent_id: string;
	agent_name: string;
	agent_details: AgentDefinition;
	events: ProviderSessionEvent[];
}> {
	const record = await requireSessionRecord(sessionId);
	const runtime = resolveSessionRuntime(record.runtime, record.agent_id, record.provider);
	const [session, events] = await Promise.all([
		readProjectRuntime(runtime, (context) => getSession(context, sessionId, record.provider)),
		listAllEvents(runtime, sessionId, record.provider),
	]);
	return {
		session: toSession(session),
		provider: record.provider,
		agent_id: record.agent_id,
		agent_name: agentDisplayName(runtime, record.agent_id),
		agent_details: sessionAgentDefinition(runtime, record.agent_id, record.provider),
		events,
	};
}

export async function cancelProjectSession(sessionId: string): Promise<void> {
	const record = await requireSessionRecord(sessionId);
	const runtime = resolveSessionRuntime(record.runtime, record.agent_id, record.provider);
	await readProjectRuntime(runtime, (context) => deleteSession(context, sessionId, record.provider));
}

export async function getProjectSessionArtifactDownload(
	sessionId: string,
	fileId: string,
): Promise<{ url: string; expires_at?: string }> {
	const record = await requireSessionRecord(sessionId);
	const runtime = resolveSessionRuntime(record.runtime, record.agent_id, record.provider);
	const events = await listAllEvents(runtime, sessionId, record.provider);
	if (!sessionOwnsArtifact(events, fileId)) {
		throw statusError(`Artifact file '${fileId}' was not found in Session '${sessionId}'.`, 404);
	}
	try {
		return await readProjectRuntime(runtime, (context) =>
			getFileDownloadUrl(context, fileId, { provider: record.provider }),
		);
	} catch (error) {
		if (error instanceof Error && /does not support file downloads/i.test(error.message)) {
			throw statusError(`Provider '${record.provider}' does not support artifact downloads.`, 422);
		}
		throw error;
	}
}

export function sessionOwnsArtifact(events: ProviderSessionEvent[], fileId: string): boolean {
	return events.some((event) => event.artifact?.file_id === fileId);
}

export async function reconstructProjectSessionBuffer(sessionId: string): Promise<boolean> {
	const record = await projectRuntimeRegistry.getSession(sessionId);
	if (!record) return false;
	let runtime: BackendRuntimeInput;
	try {
		runtime = resolveSessionRuntime(record.runtime, record.agent_id, record.provider);
	} catch {
		return false;
	}
	try {
		const session = await readProjectRuntime(runtime, (context) => getSession(context, sessionId, record.provider));
		const history = await listAllEvents(runtime, sessionId, record.provider);
		if (isTerminalSessionStatus(session.status)) {
			seedCompletedBuffer(sessionId, history);
		} else {
			const stream = await readProjectRuntime(runtime, (context) =>
				streamSessionEvents(context, sessionId, { provider: record.provider }),
			);
			createEventBuffer(sessionId, stream, history);
		}
		return true;
	} catch {
		return false;
	}
}

export function currentProjectSessionEvents(sessionId: string): ProviderSessionEvent[] {
	return getEventBuffer(sessionId)?.events ?? [];
}

async function resolveAttachments(agentId: string, provider: string, attachmentIds: string[]) {
	const attachments = await Promise.all(attachmentIds.map((id) => projectRuntimeRegistry.getAttachment(id)));
	for (let index = 0; index < attachments.length; index++) {
		const attachment = attachments[index];
		if (!attachment) throw statusError(`Attachment '${attachmentIds[index]}' was not found.`, 404);
		assertAttachmentCompatible(attachment, agentId, provider);
	}
	return attachments as Array<NonNullable<(typeof attachments)[number]>>;
}

export function assertAttachmentCompatible(attachment: AttachmentRecord, agentId: string, provider: string): void {
	if (attachment.agent_id !== agentId) {
		throw statusError(
			`Attachment '${attachment.id}' belongs to Agent '${attachment.agent_id}', not '${agentId}'.`,
			422,
		);
	}
	if (attachment.provider !== provider) {
		throw statusError(
			`Attachment '${attachment.id}' was uploaded through Provider '${attachment.provider}', not '${provider}'. Upload it again for the current Agent Provider.`,
			422,
		);
	}
	if (!attachment.available) {
		throw statusError(
			`Attachment '${attachment.filename}' is not available yet (status: ${attachment.status ?? "unknown"}).`,
			422,
		);
	}
}

async function requireSessionRecord(sessionId: string) {
	const record = await projectRuntimeRegistry.getSession(sessionId);
	if (!record) throw statusError(`Session '${sessionId}' was not found in this project.`, 404);
	return record;
}

function resolveSessionRuntime(
	pinned: BackendRuntimeInput | undefined,
	agentId: string,
	provider: string,
): BackendRuntimeInput {
	if (pinned) return pinned;
	const runtime = projectRuntimeManager.requireRuntimeInput();
	const configAgent = runtime.config.agents?.[agentId];
	if (!configAgent) throw statusError(`Session Agent '${agentId}' is no longer declared in the current project.`, 422);
	const configuredProvider = configAgent.provider ?? runtime.config.defaults?.provider;
	if (configuredProvider && configuredProvider !== provider) {
		throw statusError(`Session Provider '${provider}' no longer matches the current Agent configuration.`, 422);
	}
	return runtime;
}

async function listAllEvents(
	runtime: BackendRuntimeInput,
	sessionId: string,
	provider: string,
): Promise<ProviderSessionEvent[]> {
	return readProjectRuntime(runtime, async (context) => {
		const events: ProviderSessionEvent[] = [];
		let pageToken: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = await listSessionEvents(context, sessionId, {
				provider,
				limit: 200,
				page_token: pageToken,
			});
			events.push(...result.events);
			if (!result.has_more || !result.next_page) break;
			pageToken = result.next_page;
		}
		return events;
	});
}

function toSession(session: ProviderSessionInfo): Session {
	return {
		session_id: session.id,
		status: session.status,
		title: session.title?.trim() || session.id,
		agent: session.agent_id ? { agent_id: session.agent_id } : undefined,
		environment_id: session.environment_id,
		created_at: session.created_at,
		updated_at: session.updated_at,
	};
}

function agentDisplayName(runtime: BackendRuntimeInput, agentId: string): string {
	return runtime.config.agents?.[agentId]?.name?.trim() || agentId;
}

export function sessionAgentDefinition(
	runtime: BackendRuntimeInput,
	agentId: string,
	provider: string,
): AgentDefinition {
	const declared = runtime.config.agents?.[agentId];
	if (!declared) throw statusError(`Session Agent '${agentId}' is not present in its pinned runtime.`, 422);
	const configuredModel = declared.model;
	const providerModel = typeof configuredModel === "string" ? configuredModel : configuredModel[provider];
	const model =
		typeof providerModel === "string"
			? providerModel
			: providerModel
				? { id: providerModel.id, ...(providerModel.speed ? { speed: providerModel.speed } : {}) }
				: undefined;
	return {
		id: agentId,
		agentName: declared.name?.trim() || agentId,
		provider,
		description: declared.description,
		model,
		environment: declared.environment,
		tools: declared.tools,
		skills: (declared.skills ?? []).map((skill) =>
			typeof skill === "string"
				? { type: "custom" as const, id: skill }
				: { type: skill.type, id: skill.skill_id, version: skill.version },
		),
		mcpServers: (declared.mcp_servers ?? []).map((server) => server.name),
	};
}

function safeFilename(filename: string): string {
	return filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "upload";
}

function statusError(message: string, status: number): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

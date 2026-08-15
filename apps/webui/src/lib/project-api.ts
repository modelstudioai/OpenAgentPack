import type { components, paths } from "@/lib/api/generated/schema";

export type ProjectSummary = components["schemas"]["ProjectSummary"];
export type ProjectAgent = ProjectSummary["agents"][number];
export type AgentPlan = components["schemas"]["AgentPlanResponse"];
export type SessionDetail = components["schemas"]["CreateProjectSessionResponse"];
export type Operation = components["schemas"]["OperationResponse"];
export type OperationEvent = components["schemas"]["OperationResponse"]["events"][number];
type AttachmentListResponse =
	paths["/api/project/agents/{agentId}/attachments"]["get"]["responses"][200]["content"]["application/json"];
export type Attachment = AttachmentListResponse["attachments"][number];
type SessionArtifactDownload =
	paths["/api/sessions/{sessionId}/artifacts/{fileId}/download"]["get"]["responses"][200]["content"]["application/json"];

const accessToken = document.querySelector<HTMLMetaElement>('meta[name="agents-playground-token"]')?.content ?? "";

export async function getProject(refresh = false): Promise<ProjectSummary> {
	return requestJson(`/api/project${refresh ? "?refresh=true" : ""}`);
}

export async function planAgent(agentId: string): Promise<AgentPlan> {
	return requestJson(`/api/project/agents/${encodeURIComponent(agentId)}/plan`, {
		method: "POST",
		body: JSON.stringify({ refresh: true }),
	});
}

export async function applyAgent(
	agentId: string,
	planToken: string,
	confirmDestructive: boolean,
): Promise<{ operation_id: string; status: "queued" }> {
	return requestJson(`/api/project/agents/${encodeURIComponent(agentId)}/apply`, {
		method: "POST",
		body: JSON.stringify({ plan_token: planToken, confirm_destructive: confirmDestructive }),
	});
}

export async function getOperation(operationId: string): Promise<Operation> {
	return requestJson(`/api/operations/${encodeURIComponent(operationId)}`);
}

export async function listAttachments(agentId: string): Promise<Attachment[]> {
	const response = await requestJson<{ attachments: Attachment[] }>(
		`/api/project/agents/${encodeURIComponent(agentId)}/attachments`,
	);
	return response.attachments;
}

export async function uploadAttachment(agentId: string, file: File): Promise<Attachment> {
	const form = new FormData();
	form.append("file", file);
	return requestJson(`/api/project/agents/${encodeURIComponent(agentId)}/attachments`, {
		method: "POST",
		body: form,
	});
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
	await requestJson(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
}

export async function startSession(
	agentId: string,
	prompt?: string,
	attachmentIds: string[] = [],
): Promise<SessionDetail> {
	return requestJson(`/api/project/agents/${encodeURIComponent(agentId)}/sessions`, {
		method: "POST",
		body: JSON.stringify({ ...(prompt ? { prompt } : {}), attachment_ids: attachmentIds }),
	});
}

export async function sendSessionMessage(sessionId: string, message: string): Promise<SessionDetail> {
	return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		body: JSON.stringify({ message }),
	});
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
	return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getSessionArtifactDownloadUrl(sessionId: string, fileId: string): Promise<string> {
	const result = await requestJson<SessionArtifactDownload>(
		`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(fileId)}/download`,
	);
	return result.url;
}

export async function cancelSession(sessionId: string): Promise<void> {
	await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
}

export function projectEventSource(): EventSource {
	return new EventSource("/api/project/events");
}

export function operationEventSource(operationId: string, after = -1): EventSource {
	return new EventSource(`/api/operations/${encodeURIComponent(operationId)}/events?after=${after}`);
}

export function sessionEventSource(sessionId: string, after = -1): EventSource {
	return new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
	if (init.method && init.method !== "GET" && accessToken) headers.set("X-Agents-Playground-Token", accessToken);
	const response = await fetch(url, { ...init, headers, cache: "no-store" });
	const text = await response.text();
	const payload = text ? safeJson(text) : undefined;
	if (!response.ok) {
		const message = readErrorMessage(payload) ?? `HTTP ${response.status}`;
		throw Object.assign(new Error(message), { status: response.status });
	}
	return payload as T;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readErrorMessage(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const error = (value as { error?: unknown }).error;
	if (!error || typeof error !== "object") return undefined;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? message : undefined;
}

import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	deleteFile,
	getAgent,
	getFileInfo,
	readProjectRuntime,
	type SessionEvent,
	uploadFile,
} from "@openagentpack/sdk";
import { ErrorResponseSchema, errorResponses } from "@/schemas/common";
import { UploadFileFormSchema } from "@/schemas/files";
import {
	AttachmentDeleteResponseSchema,
	AttachmentListResponseSchema,
	AttachmentParamsSchema,
	AttachmentSchema,
	CreateProjectSessionBodySchema,
	CreateProjectSessionResponseSchema,
	ProjectAgentParamsSchema,
	ProjectSessionArtifactDownloadSchema,
	ProjectSessionArtifactParamsSchema,
	ProjectSessionParamsSchema,
	SendProjectSessionMessageBodySchema,
	StreamAfterQuerySchema,
} from "@/schemas/project";
import { projectRuntimeManager } from "@/services/project-manager";
import { projectRuntimeRegistry } from "@/services/project-runtime-registry";
import {
	cancelProjectSession,
	getProjectSessionArtifactDownload,
	getProjectSessionDetail,
	reconstructProjectSessionBuffer,
	sendProjectSessionMessage,
	startProjectSession,
} from "@/services/project-sessions";
import { getEventBuffer, subscribeEvents } from "@/services/sessions/event-buffer";
import { sanitizeSessionEvent, sanitizeSessionEvents } from "@/services/sessions/event-sanitizer";

export const projectSessionsRoute = new OpenAPIHono();
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const createSessionRoute = createRoute({
	method: "post",
	path: "/project/agents/{agentId}/sessions",
	request: {
		params: ProjectAgentParamsSchema,
		body: { content: { "application/json": { schema: CreateProjectSessionBodySchema } } },
	},
	responses: {
		201: {
			description: "Session created from the selected agents.yaml Agent",
			content: { "application/json": { schema: CreateProjectSessionResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(createSessionRoute, async (context) => {
	const { agentId } = context.req.valid("param");
	const { prompt, title, attachment_ids: attachmentIds } = context.req.valid("json");
	const result = await startProjectSession({
		agentId,
		prompt: prompt?.trim(),
		title,
		attachmentIds,
	});
	return context.json({ ...result, events: sanitizeSessionEvents(result.events) }, 201);
});

const sendMessageRoute = createRoute({
	method: "post",
	path: "/sessions/{sessionId}/messages",
	request: {
		params: ProjectSessionParamsSchema,
		body: { content: { "application/json": { schema: SendProjectSessionMessageBodySchema } } },
	},
	responses: {
		200: {
			description: "Follow up in a project Session using its pinned runtime",
			content: { "application/json": { schema: CreateProjectSessionResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(sendMessageRoute, async (context) => {
	const { sessionId } = context.req.valid("param");
	const { message } = context.req.valid("json");
	const result = await sendProjectSessionMessage(sessionId, message.trim());
	return context.json({ ...result, events: sanitizeSessionEvents(result.events) }, 200);
});

const getSessionRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}",
	request: { params: ProjectSessionParamsSchema },
	responses: {
		200: {
			description: "Project Session detail, history, and artifacts carried by events",
			content: { "application/json": { schema: CreateProjectSessionResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(getSessionRoute, async (context) => {
	const { sessionId } = context.req.valid("param");
	const result = await getProjectSessionDetail(sessionId);
	return context.json({ ...result, events: sanitizeSessionEvents(result.events) }, 200);
});

const getSessionArtifactDownloadRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}/artifacts/{fileId}/download",
	request: { params: ProjectSessionArtifactParamsSchema },
	responses: {
		200: {
			description: "Resolve a short-lived download URL for an artifact delivered by this Session",
			content: { "application/json": { schema: ProjectSessionArtifactDownloadSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(getSessionArtifactDownloadRoute, async (context) => {
	const { sessionId, fileId } = context.req.valid("param");
	return context.json(await getProjectSessionArtifactDownload(sessionId, fileId), 200);
});

const cancelSessionRoute = createRoute({
	method: "post",
	path: "/sessions/{sessionId}/cancel",
	request: { params: ProjectSessionParamsSchema },
	responses: {
		200: {
			description: "Terminate/delete the provider Session",
			content: { "application/json": { schema: z.object({ session_id: z.string(), cancelled: z.literal(true) }) } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(cancelSessionRoute, async (context) => {
	const { sessionId } = context.req.valid("param");
	await cancelProjectSession(sessionId);
	return context.json({ session_id: sessionId, cancelled: true as const }, 200);
});

const streamSessionRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}/events",
	request: { params: ProjectSessionParamsSchema, query: StreamAfterQuerySchema },
	responses: {
		200: {
			description: "Replay and stream Session events",
			content: { "text/event-stream": { schema: z.string() } },
		},
		204: { description: "Session is unavailable" },
		...errorResponses,
	},
});

projectSessionsRoute.openapi(streamSessionRoute, async (context) => {
	const { sessionId } = context.req.valid("param");
	let buffer = getEventBuffer(sessionId);
	if (!buffer && (await reconstructProjectSessionBuffer(sessionId))) buffer = getEventBuffer(sessionId);
	if (!buffer) return new Response(null, { status: 204 });
	const { after } = context.req.valid("query");
	const lastEventId = Number(context.req.header("Last-Event-ID"));
	const replayAfter = Number.isInteger(lastEventId) ? Math.max(after ?? -1, lastEventId) : (after ?? -1);
	return streamSessionBuffer(buffer, replayAfter);
});

const uploadAttachmentRoute = createRoute({
	method: "post",
	path: "/project/agents/{agentId}/attachments",
	request: {
		params: ProjectAgentParamsSchema,
		body: { required: true, content: { "multipart/form-data": { schema: UploadFileFormSchema } } },
	},
	responses: {
		201: {
			description: "Ad-hoc Session attachment uploaded",
			content: { "application/json": { schema: AttachmentSchema } },
		},
		413: {
			description: "File exceeds the upload limit",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(
	uploadAttachmentRoute,
	async (context) => {
		await projectRuntimeManager.ensureStarted();
		const { agentId } = context.req.valid("param");
		const { file } = context.req.valid("form");
		if (file.size === 0) return context.json({ error: { message: "file is required" } }, 400);
		if (file.size > MAX_UPLOAD_BYTES) return context.json({ error: { message: "file too large" } }, 413);
		const content = new Uint8Array(await file.arrayBuffer());
		const runtime = projectRuntimeManager.requireRuntimeInput();
		const provider = await readProjectRuntime(runtime, (projectContext) => getAgent(projectContext, agentId).provider);
		const uploaded = await readProjectRuntime(runtime, (projectContext) =>
			uploadFile(projectContext, content, file.name || "upload", {
				provider,
				mimeType: file.type || undefined,
			}),
		);
		const attachment = {
			id: randomUUID(),
			agent_id: agentId,
			provider,
			remote_file_id: uploaded.id,
			filename: uploaded.filename,
			mime_type: uploaded.mime_type || undefined,
			status: uploaded.status,
			available: uploaded.available,
			created_at: uploaded.created_at || new Date().toISOString(),
		};
		await projectRuntimeRegistry.putAttachment(attachment);
		return context.json(attachment, 201);
	},
	(_result, context) => context.json({ error: { message: "file is required" } }, 400),
);

const listAttachmentsRoute = createRoute({
	method: "get",
	path: "/project/agents/{agentId}/attachments",
	request: { params: ProjectAgentParamsSchema },
	responses: {
		200: {
			description: "List ad-hoc attachments",
			content: { "application/json": { schema: AttachmentListResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(listAttachmentsRoute, async (context) => {
	const { agentId } = context.req.valid("param");
	let attachments = await projectRuntimeRegistry.listAttachments(agentId);
	const snapshot = projectRuntimeManager.getSnapshot();
	if (snapshot.status === "valid" && snapshot.input) {
		const runtime = snapshot.input;
		attachments = await Promise.all(
			attachments.map(async (attachment) => {
				if (attachment.available) return attachment;
				try {
					const info = await readProjectRuntime(runtime, (projectContext) =>
						getFileInfo(projectContext, attachment.remote_file_id, { provider: attachment.provider }),
					);
					const refreshed = {
						...attachment,
						filename: info.filename,
						mime_type: info.mime_type || attachment.mime_type,
						status: info.status,
						available: info.available,
					};
					await projectRuntimeRegistry.putAttachment(refreshed);
					return refreshed;
				} catch (error) {
					// Keep the local cleanup record when metadata lookup is unavailable or transiently fails.
					if (error instanceof Error && error.message.includes("does not support file metadata lookup")) {
						const unavailable = { ...attachment, status: "capability_unavailable" };
						await projectRuntimeRegistry.putAttachment(unavailable);
						return unavailable;
					}
					return attachment;
				}
			}),
		);
	}
	return context.json({ attachments }, 200);
});

const deleteAttachmentRoute = createRoute({
	method: "delete",
	path: "/attachments/{attachmentId}",
	request: { params: AttachmentParamsSchema },
	responses: {
		200: {
			description: "Remote attachment deleted",
			content: { "application/json": { schema: AttachmentDeleteResponseSchema } },
		},
		...errorResponses,
	},
});

projectSessionsRoute.openapi(deleteAttachmentRoute, async (context) => {
	const { attachmentId } = context.req.valid("param");
	const attachment = await projectRuntimeRegistry.getAttachment(attachmentId);
	if (!attachment) throw statusError(`Attachment '${attachmentId}' was not found.`, 404);
	const runtime = projectRuntimeManager.requireRuntimeInput();
	await readProjectRuntime(runtime, (projectContext) =>
		deleteFile(projectContext, attachment.remote_file_id, { provider: attachment.provider }),
	);
	await projectRuntimeRegistry.removeAttachment(attachmentId);
	return context.json({ attachment_id: attachmentId, deleted: true as const }, 200);
});

function streamSessionBuffer(buffer: NonNullable<ReturnType<typeof getEventBuffer>>, afterIndex: number): Response {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	const stream = new ReadableStream({
		start(controller) {
			const send = (type: string, data: unknown) => {
				if (!closed) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
			};
			const sendEvent = (event: Parameters<typeof sanitizeSessionEvent>[0], index: number) => {
				const sanitized: SessionEvent = sanitizeSessionEvent(event);
				if (!closed) {
					controller.enqueue(encoder.encode(`id: ${index}\nevent: event\ndata: ${JSON.stringify(sanitized)}\n\n`));
				}
			};
			for (let index = afterIndex + 1; index < buffer.events.length; index++) sendEvent(buffer.events[index]!, index);
			if (buffer.done) {
				send("done", { error: buffer.error ?? null });
				closed = true;
				controller.close();
				return;
			}
			unsubscribe = subscribeEvents(buffer.sessionId, (event) => {
				if (event) sendEvent(event, buffer.events.length - 1);
				else {
					send("done", { error: buffer.error ?? null });
					closed = true;
					unsubscribe?.();
					if (ping) clearInterval(ping);
					controller.close();
				}
			});
			ping = setInterval(() => send("ping", {}), 15_000);
		},
		cancel() {
			closed = true;
			unsubscribe?.();
			if (ping) clearInterval(ping);
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

function statusError(message: string, status: number): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

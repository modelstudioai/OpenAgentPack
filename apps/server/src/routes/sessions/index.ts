import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import {
	CreateSessionBodySchema,
	SessionDetailResponseSchema,
	SessionListResponseSchema,
	SessionsQuerySchema,
} from "@/schemas/sessions";
import { sanitizeSessionEvents } from "@/services/sessions/event-sanitizer";
import { listSessionsForAgent, startSession } from "@/services/sessions/runner";
import { sessionsDetailRoute } from "./detail";
import { sessionsEventsRoute } from "./events";
import { sessionsMessagesRoute } from "./messages";
import { sessionsStreamRoute } from "./stream";

export const sessionsRoute = new OpenAPIHono();

const listSessionsRoute = createRoute({
	method: "get",
	path: "/sessions",
	request: {
		query: SessionsQuerySchema,
	},
	responses: {
		200: {
			description: "List sessions for an agent",
			content: { "application/json": { schema: SessionListResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsRoute.openapi(listSessionsRoute, async (c) => {
	const { limit, agentId, pageToken } = c.req.valid("query");
	const resolvedAgentId = agentId?.trim() || undefined;
	const requestedLimit = limit ?? 50;
	const safeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
	const { sessions, nextPageToken } = await listSessionsForAgent({
		agentId: resolvedAgentId,
		limit: safeLimit,
		pageToken: pageToken?.trim() || undefined,
	});
	return c.json({ data: sessions, next_page_token: nextPageToken ?? null }, 200);
});

const createSessionRoute = createRoute({
	method: "post",
	path: "/sessions",
	request: {
		body: {
			content: { "application/json": { schema: CreateSessionBodySchema } },
		},
	},
	responses: {
		201: {
			description: "Session created",
			content: { "application/json": { schema: SessionDetailResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsRoute.openapi(createSessionRoute, async (c) => {
	const { agentId, prompt, title, environmentId, vaultIds, files, model } = c.req.valid("json");
	const trimmedPrompt = prompt.trim();
	if (!agentId.trim() || !trimmedPrompt) {
		return c.json({ error: { message: "agentId and prompt are required" } }, 400);
	}
	if (!environmentId.trim()) {
		return c.json({ error: { message: "environmentId is required" } }, 400);
	}
	const { session, events } = await startSession({
		agentId,
		prompt: trimmedPrompt,
		title,
		environmentId,
		vaultIds,
		files,
		model,
	});
	return c.json({ session, events: sanitizeSessionEvents(events) }, 201);
});

sessionsRoute.route("/", sessionsDetailRoute);
sessionsRoute.route("/", sessionsEventsRoute);
sessionsRoute.route("/", sessionsMessagesRoute);
sessionsRoute.route("/", sessionsStreamRoute);

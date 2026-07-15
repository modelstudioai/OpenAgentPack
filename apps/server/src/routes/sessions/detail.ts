import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import {
	SessionDeleteResponseSchema,
	SessionDetailQuerySchema,
	SessionDetailResponseSchema,
	SessionParamsSchema,
} from "@/schemas/sessions";
import { sanitizeSessionEvents, shouldIncludeDebugRaw } from "@/services/sessions/event-sanitizer";
import { deleteSession, getSessionDetail } from "@/services/sessions/runner";

export const sessionsDetailRoute = new OpenAPIHono();

const getSessionRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}",
	request: {
		params: SessionParamsSchema,
		query: SessionDetailQuerySchema,
	},
	responses: {
		200: {
			description: "Session detail with events",
			content: { "application/json": { schema: SessionDetailResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsDetailRoute.openapi(getSessionRoute, async (c) => {
	const { sessionId } = c.req.valid("param");
	const { agentId } = c.req.valid("query");
	const { session, events, eventsNextPageToken } = await getSessionDetail(sessionId, agentId?.trim() || undefined);
	const includeRaw = shouldIncludeDebugRaw(c.req.raw);
	return c.json(
		{
			session,
			events: sanitizeSessionEvents(events, { includeRaw }),
			events_next_page_token: eventsNextPageToken ?? null,
		},
		200,
	);
});

const deleteSessionRoute = createRoute({
	method: "delete",
	path: "/sessions/{sessionId}",
	request: {
		params: SessionParamsSchema,
		query: SessionDetailQuerySchema,
	},
	responses: {
		200: {
			description: "Session deleted",
			content: { "application/json": { schema: SessionDeleteResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsDetailRoute.openapi(deleteSessionRoute, async (c) => {
	const { sessionId } = c.req.valid("param");
	const { agentId } = c.req.valid("query");
	await deleteSession(sessionId, agentId?.trim() || undefined);
	return c.json({ session_id: sessionId, deleted: true }, 200);
});

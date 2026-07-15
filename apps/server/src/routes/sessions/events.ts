import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import { SessionEventsPageResponseSchema, SessionEventsQuerySchema, SessionParamsSchema } from "@/schemas/sessions";
import { sanitizeSessionEvents, shouldIncludeDebugRaw } from "@/services/sessions/event-sanitizer";
import { listSessionEventsPage } from "@/services/sessions/runner";

export const sessionsEventsRoute = new OpenAPIHono();

const listSessionEventsRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}/events",
	request: {
		params: SessionParamsSchema,
		query: SessionEventsQuerySchema,
	},
	responses: {
		200: {
			description: "Paginated session events (newest page first; pass pageToken for older pages)",
			content: { "application/json": { schema: SessionEventsPageResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsEventsRoute.openapi(listSessionEventsRoute, async (c) => {
	const { sessionId } = c.req.valid("param");
	const { agentId, pageToken, limit } = c.req.valid("query");
	const requestedLimit = limit ?? 100;
	const safeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200) : 100;
	const { events, eventsNextPageToken } = await listSessionEventsPage(
		sessionId,
		agentId?.trim() || undefined,
		pageToken?.trim() || undefined,
		safeLimit,
	);
	const includeRaw = shouldIncludeDebugRaw(c.req.raw);
	return c.json(
		{
			events: sanitizeSessionEvents(events, { includeRaw }),
			events_next_page_token: eventsNextPageToken ?? null,
		},
		200,
	);
});

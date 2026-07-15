import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import { SendMessageBodySchema, SessionDetailResponseSchema, SessionParamsSchema } from "@/schemas/sessions";
import { sanitizeSessionEvents } from "@/services/sessions/event-sanitizer";
import { sendMessage } from "@/services/sessions/runner";

export const sessionsMessagesRoute = new OpenAPIHono();

const sendMessageRoute = createRoute({
	method: "post",
	path: "/sessions/{sessionId}/messages",
	request: {
		params: SessionParamsSchema,
		body: {
			content: { "application/json": { schema: SendMessageBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Message sent; updated session with events",
			content: { "application/json": { schema: SessionDetailResponseSchema } },
		},
		...errorResponses,
	},
});

sessionsMessagesRoute.openapi(sendMessageRoute, async (c) => {
	const { sessionId } = c.req.valid("param");
	const { agentId, message } = c.req.valid("json");
	const trimmedMessage = message.trim();
	if (!trimmedMessage) {
		return c.json({ error: { message: "message is required" } }, 400);
	}
	const { session, events } = await sendMessage(sessionId, trimmedMessage, agentId);
	return c.json({ session, events: sanitizeSessionEvents(events) }, 200);
});

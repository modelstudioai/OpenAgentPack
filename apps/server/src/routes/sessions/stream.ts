import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ProviderSessionEvent, SessionEvent } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import { SessionParamsSchema } from "@/schemas/sessions";
import { getEventBuffer, type SessionEventBuffer, subscribeEvents } from "@/services/sessions/event-buffer";
import { sanitizeSessionEvent } from "@/services/sessions/event-sanitizer";
import { reconstructSessionBuffer } from "@/services/sessions/runner";

export const sessionsStreamRoute = new OpenAPIHono();

const SessionStreamQuerySchema = z.object({
	after: z.preprocess((value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}, z.number().int().optional()),
});

const streamSessionRoute = createRoute({
	method: "get",
	path: "/sessions/{sessionId}/stream",
	request: {
		params: SessionParamsSchema,
		query: SessionStreamQuerySchema,
	},
	responses: {
		200: {
			description: "Stream session events as Server-Sent Events",
			content: {
				"text/event-stream": {
					schema: z.string().openapi({
						description: 'SSE frames with event types "event", "done", and "ping".',
					}),
				},
			},
		},
		204: {
			description: "No active event buffer; caller should fetch the session detail once",
		},
		...errorResponses,
	},
});

/**
 * SSE endpoint for streaming session events in real-time.
 *
 * Query params:
 *  - after: index of the last event the client already has (0-based).
 *           Events starting from (after + 1) will be replayed, then new
 *           events streamed in real-time.
 *
 * SSE event types:
 *  - "event": a sanitized provider session event (JSON)
 *  - "done":  the stream has ended (final message)
 *  - "ping":  keep-alive (every 15s)
 *
 * On a buffer miss (server restart / eviction / a second client) the buffer is rebuilt from
 * the provider statelessly: terminal sessions replay their history; running sessions also
 * attach the provider's native event stream. 204 now means only "session not found".
 */
sessionsStreamRoute.openapi(streamSessionRoute, async (c) => {
	const { sessionId } = c.req.valid("param");

	let buffer = getEventBuffer(sessionId);
	if (!buffer) {
		const reconstructed = await reconstructSessionBuffer(sessionId);
		buffer = reconstructed ? getEventBuffer(sessionId) : undefined;
	}
	if (!buffer) {
		return new Response(null, { status: 204 });
	}

	const { after } = c.req.valid("query");
	const afterIndex = after ?? -1;
	return streamFromBuffer(c.req.raw.signal, buffer, afterIndex);
});

function streamFromBuffer(signal: AbortSignal, buffer: SessionEventBuffer, afterIndex: number): Response {
	const startFrom = Number.isFinite(afterIndex) ? afterIndex + 1 : 0;

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe: (() => void) | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const send = (eventType: string, data: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${data}\n\n`));
				} catch {
					closed = true;
				}
			};

			const sendEvent = (event: ProviderSessionEvent) => {
				// Payload type derived from the shared schema keeps the SSE frame
				// in lockstep with the generated REST event model.
				const safe: SessionEvent = sanitizeSessionEvent(event);
				send("event", JSON.stringify(safe));
			};

			// 1. Replay buffered events the client hasn't seen
			const bufferedEvents = buffer.events;
			for (let i = startFrom; i < bufferedEvents.length; i++) {
				sendEvent(bufferedEvents[i]);
			}

			// 2. If buffer is already done, send completion and close
			if (buffer.done) {
				send("done", JSON.stringify({ error: buffer.error ?? null }));
				closed = true;
				controller.close();
				return;
			}

			// 3. Subscribe for new real-time events
			let nextIndex = bufferedEvents.length;
			unsubscribe = subscribeEvents(buffer.sessionId, (event) => {
				if (closed) return;

				if (event === null) {
					// Stream ended
					send("done", JSON.stringify({ error: buffer.error ?? null }));
					closed = true;
					cleanup();
					controller.close();
					return;
				}

				// Only send events we haven't replayed yet
				// (in case of race between replay and subscribe)
				const currentIndex = buffer.events.indexOf(event);
				if (currentIndex >= nextIndex) {
					sendEvent(event);
					nextIndex = currentIndex + 1;
				}
			});

			// 4. Keep-alive ping every 15 seconds
			pingTimer = setInterval(() => {
				if (closed) return;
				send("ping", "{}");
			}, 15000);
		},

		cancel() {
			closed = true;
			cleanup();
		},
	});

	function cleanup() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (pingTimer) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
	}

	// Handle client disconnect via AbortSignal
	signal.addEventListener("abort", () => {
		closed = true;
		cleanup();
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

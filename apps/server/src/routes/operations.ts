import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import { OperationParamsSchema, OperationResponseSchema, StreamAfterQuerySchema } from "@/schemas/project";
import { type OperationEvent, projectOperationStore } from "@/services/project-operations";

export const operationsRoute = new OpenAPIHono();

const getOperationRoute = createRoute({
	method: "get",
	path: "/operations/{operationId}",
	request: { params: OperationParamsSchema },
	responses: {
		200: {
			description: "Current asynchronous operation state",
			content: { "application/json": { schema: OperationResponseSchema } },
		},
		...errorResponses,
	},
});

operationsRoute.openapi(getOperationRoute, (context) => {
	const { operationId } = context.req.valid("param");
	return context.json(projectOperationStore.get(operationId), 200);
});

const streamOperationRoute = createRoute({
	method: "get",
	path: "/operations/{operationId}/events",
	request: { params: OperationParamsSchema, query: StreamAfterQuerySchema },
	responses: {
		200: {
			description: "Replay and stream asynchronous operation events",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...errorResponses,
	},
});

operationsRoute.openapi(streamOperationRoute, (context) => {
	const { operationId } = context.req.valid("param");
	const { after } = context.req.valid("query");
	const lastEventId = Number(context.req.header("Last-Event-ID"));
	const replayAfter = Number.isInteger(lastEventId) ? Math.max(after ?? -1, lastEventId) : (after ?? -1);
	const operation = projectOperationStore.get(operationId);
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	const stream = new ReadableStream({
		start(controller) {
			const send = (type: string, data: unknown, id?: number) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};
			const sendEvent = (event: OperationEvent) => send("event", event, event.index);
			for (const event of operation.events.slice(replayAfter + 1)) sendEvent(event);
			if (isTerminal(operation.status)) {
				send("done", { status: operation.status, error: operation.error ?? null });
				closed = true;
				controller.close();
				return;
			}
			unsubscribe = projectOperationStore.subscribe(operationId, (event) => {
				if (event) sendEvent(event);
				else {
					const latest = projectOperationStore.get(operationId);
					send("done", { status: latest.status, error: latest.error ?? null });
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
});

function isTerminal(status: string): boolean {
	return status === "completed" || status === "failed" || status === "interrupted";
}

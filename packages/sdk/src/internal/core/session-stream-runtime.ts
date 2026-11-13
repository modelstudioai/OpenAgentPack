import { UserError } from "../errors.ts";
import { sessionEventFormat } from "../providers/session-event-options.ts";
import { bindSessionStreamTurn } from "../providers/session-stream-turn.ts";
import type { EventStreamOptions, ProviderSessionEvent } from "../types/session-event.ts";
import type { SessionWorkflowAdapter } from "./session-runtime.ts";

const END_STATUSES = new Set(["idle", "completed", "failed", "terminated", "deleted"]);

/** A ready-capable adapter must establish the SSE connection before the POST can start. */
export async function* streamReadyBeforeSend(
	adapter: SessionWorkflowAdapter,
	sessionId: string,
	message: string,
	options: EventStreamOptions = {},
): AsyncGenerator<ProviderSessionEvent> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const streamOptions: EventStreamOptions = {
		...options,
		signal: controller.signal,
		onReady: () => {
			options.onReady?.();
			resolveReady();
		},
	};
	const snapshot = sessionEventFormat(options) === "snapshot";
	const resolveTurnStart = snapshot ? bindSessionStreamTurn(streamOptions) : undefined;
	const iterator = adapter.streamSessionEvents(sessionId, streamOptions)[Symbol.asyncIterator]();
	let pending: Promise<IteratorResult<ProviderSessionEvent>> | undefined;
	let observedRun = false;
	try {
		pending = iterator.next();
		// Attach an error handler before waiting for readiness; connection failures must not send.
		await Promise.race([
			ready,
			pending.then(() => {
				throw new UserError("Session stream ended or emitted an event before connection readiness.");
			}),
		]);
		if (controller.signal.aborted) throw new DOMException("Session stream cancelled.", "AbortError");
		const sentEventId = await waitForSend(adapter.sendSessionMessage(sessionId, message), controller.signal);
		resolveTurnStart?.(sentEventId);
		while (true) {
			const item = await pending;
			if (controller.signal.aborted) throw new DOMException("Session stream cancelled.", "AbortError");
			if (item.done) return;
			const event = item.value;
			yield event;
			if (snapshot) {
				if (
					event.status === "running" ||
					event.role === "assistant" ||
					event.type === "tool_use" ||
					event.type === "thinking"
				)
					observedRun = true;
				// Ignore an initial idle subscription snapshot before the new run becomes visible.
				if (
					event.type === "status" &&
					END_STATUSES.has(event.status ?? "") &&
					(observedRun || event.status !== "idle" || event.stop_reason === "requires_action")
				)
					return;
			}
			pending = iterator.next();
		}
	} finally {
		controller.abort();
		await pending?.catch(() => {});
		await iterator.return?.();
		options.signal?.removeEventListener("abort", abort);
	}
}

// Cancelling observation does not cancel provider execution and must never trigger a resend.
async function waitForSend<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new DOMException("Session stream cancelled.", "AbortError"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([pending, cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

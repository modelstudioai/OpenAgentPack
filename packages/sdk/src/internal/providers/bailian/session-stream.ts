import { UserError } from "../../errors.ts";
import type { EventStreamOptions, ProviderSessionEvent } from "../../types/session-event.ts";
import { ApiError, type BaseApiClient, SseTransportError } from "../base-client.ts";
import { assertStreamOptions, sessionEventFormat } from "../session-event-options.ts";
import { listSessionEventsPaged } from "../session-event-response.ts";
import { sessionStreamTurn } from "../session-stream-turn.ts";
import { BailianEventAccumulator } from "./event-accumulator.ts";
import { toSessionEvent } from "./event-mapper.ts";

const MAX_BUFFERED_FRAMES = 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const RETRY_DELAYS = [250, 500, 1000];
const TERMINAL_STATUSES = new Set(["idle", "completed", "failed", "terminated", "deleted"]);
type RawEvent = Record<string, unknown>;

/** Bailian has no native cursor replay. Recovery combines a live subscription with REST history. */
export async function* streamBailianSessionEvents(
	client: BaseApiClient,
	sessionId: string,
	options: EventStreamOptions = {},
): AsyncGenerator<ProviderSessionEvent> {
	assertStreamOptions("bailian", options);
	const snapshot = sessionEventFormat(options) === "snapshot";
	const params = new URLSearchParams();
	for (const type of new Set(options.event_deltas)) params.append("event_deltas[]", type);
	const path = `/sessions/${sessionId}/events/stream${params.size ? `?${params}` : ""}`;
	if (!snapshot) {
		for await (const raw of client.sse(path, options)) yield toSessionEvent(raw);
		return;
	}

	const accumulator = new BailianEventAccumulator();
	// History may create a status before the answer it later completes. Keep such
	// updates until all history is repaired, including across a failed history attempt.
	const recoveredStatuses = new Map<string, { event: ProviderSessionEvent; deliveredSnapshot?: string }>();
	const unfinished = new Set<string>();
	const turnStart = sessionStreamTurn(options);
	let retries = 0;
	let recover = options.after_id !== undefined;
	let lastCompletedId = options.after_id;
	while (true) {
		throwIfAborted(options.signal);
		const controller = new AbortController();
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		let pump: Promise<void> | undefined;
		let queue: FrameQueue | undefined;
		try {
			throwIfAborted(options.signal);
			const ready = deferred();
			// This rejection always has a handler, including failures before onReady.
			void ready.promise.catch(() => {});
			queue = new FrameQueue();
			const activeQueue = queue;
			const source = client.sse(path, {
				...options,
				strict: true,
				signal: controller.signal,
				onReady: () => {
					options.onReady?.();
					ready.resolve();
				},
			});
			pump = (async () => {
				try {
					for await (const raw of source) activeQueue.push(raw);
					throw new SseTransportError("unexpected-eof");
				} catch (error) {
					ready.reject(error);
					activeQueue.fail(error);
				}
			})();
			await ready.promise;
			throwIfAborted(options.signal);
			let repairingWithLiveStatus = false;
			if (recover) {
				// onReady has already allowed the parent to POST. Wait for its identity
				// before replaying history, including initial after_id subscriptions.
				const sentEventId = turnStart
					? await waitForHistory(turnStart, activeQueue, controller.signal, options.connectTimeoutMs ?? 30_000)
					: undefined;
				if (turnStart && !sentEventId) {
					throw new UserError("Cannot recover this session turn: send response did not include an event id.");
				}
				let turnFound = turnStart === undefined;
				const interrupted = new Set(accumulator.pendingMessageIds());
				for (const id of interrupted) trackUnfinished(unfinished, id);
				const delivered = accumulator.captureDelivery();
				accumulator.resetPartials();
				const marker = lastCompletedId ?? sentEventId;
				let markerFound = marker === undefined;
				const cursors = new Set<string>();
				let page: string | undefined;
				do {
					throwIfAborted(options.signal);
					const result = await waitForHistory(
						listSessionEventsPaged(
							client,
							sessionId,
							{
								limit: 100,
								order: "asc",
								page_token: page,
								signal: controller.signal,
							},
							(raw) => toSessionEvent(raw, { event_format: "snapshot" }),
							{ forwardTypes: false },
						),
						activeQueue,
						controller.signal,
						options.connectTimeoutMs ?? 30_000,
					);
					for (const event of result.events) {
						throwIfAborted(options.signal);
						if (event.id === sentEventId) turnFound = true;
						const beforeMarker = !markerFound;
						if (event.id === marker) {
							markerFound = true;
							if (turnFound) lastCompletedId = marker;
						}
						// In-progress history has no frame-level watermark; never append live deltas to it.
						if (event.raw.status === "in_progress") {
							if (event.id && accumulator.isCompleted(event.id)) continue;
							if (
								turnFound &&
								(!beforeMarker ||
									(event.id && (interrupted.has(event.id) || delivered.has(event.id) || unfinished.has(event.id))))
							) {
								if (!event.id) throw new UserError("Unfinished Session history is missing its event ID.");
								trackUnfinished(unfinished, event.id);
							}
							continue;
						}
						const mapped = accumulator.seed(event.raw);
						if (event.id) unfinished.delete(event.id);
						// Still seed old events for correlation/dedup, but never deliver a
						// previous turn's assistant or terminal state to a single-turn send.
						if (!turnFound) continue;
						if (mapped) {
							// Creation order differs from update/completion order. Only IDs
							// actually delivered (or interrupted) may cross an exclusive marker.
							if (
								beforeMarker &&
								(!mapped.id ||
									(!interrupted.has(mapped.id) && !delivered.has(mapped.id) && !recoveredStatuses.has(mapped.id)))
							)
								continue;
							const pendingStatus = mapped.id ? recoveredStatuses.get(mapped.id) : undefined;
							if (delivered.matches(mapped, pendingStatus?.deliveredSnapshot)) {
								if (mapped.id) recoveredStatuses.delete(mapped.id);
								accumulator.markDelivered(mapped);
								continue;
							}
							if (mapped.id && !beforeMarker) lastCompletedId = mapped.id;
							if (
								mapped.id &&
								mapped.type === "status" &&
								(recoveredStatuses.size > 0 || TERMINAL_STATUSES.has(mapped.status ?? ""))
							) {
								// Replacing the same ID also cancels a deferred terminal state
								// if a later recovery observes it running again.
								if (!recoveredStatuses.has(mapped.id) && recoveredStatuses.size >= MAX_BUFFERED_FRAMES)
									throw new UserError("Session status recovery buffer exceeded its limit.");
								recoveredStatuses.set(mapped.id, {
									event: mapped,
									// Retain only the original delivery fingerprint across retries:
									// older history pages may evict the accumulator's copy.
									deliveredSnapshot: pendingStatus?.deliveredSnapshot ?? delivered.get(mapped.id),
								});
								continue;
							}
							accumulator.markDelivered(mapped);
							yield mapped;
						}
					}
					if (result.has_more && !result.next_page)
						throw new UserError("Session event history is missing a pagination cursor.");
					page = result.next_page;
					if (page && cursors.has(page)) throw new UserError("Session event pagination returned a repeated cursor.");
					if (page) cursors.add(page);
				} while (page);
				if (!turnFound) throw new UserError("Session turn's sent event was not found in history.");
				if (!markerFound) throw new UserError("Session event resume marker was not found in history.");
				// Pages are not a consistent snapshot. If text still needs repair, a
				// historical terminal state cannot establish a safe handoff to live events.
				// Require a live status after all unfinished identities have converged instead.
				repairingWithLiveStatus = unfinished.size > 0;
				if (repairingWithLiveStatus) recoveredStatuses.clear();
				for (const [id, { event }] of recoveredStatuses) {
					throwIfAborted(options.signal);
					recoveredStatuses.delete(id);
					accumulator.markDelivered(event);
					yield event;
				}
			}
			while (true) {
				throwIfAborted(options.signal);
				const raw = repairingWithLiveStatus
					? await waitForHistory(queue.next(), activeQueue, controller.signal, options.connectTimeoutMs ?? 30_000)
					: await queue.next();
				throwIfAborted(options.signal);
				let event = accumulator.push(raw);
				if (repairingWithLiveStatus) {
					const id =
						event?.id ??
						(typeof raw.id === "string" ? raw.id : typeof raw.event_id === "string" ? raw.event_id : undefined);
					if (id && accumulator.isCompleted(id)) unfinished.delete(id);
					else if (event?.id) trackUnfinished(unfinished, event.id);
					// A complete live status may duplicate the historical status that was
					// deliberately withheld. Its position after the repaired answer still matters.
					if (!event && raw.type === "session_status") event = toSessionEvent(raw, { event_format: "snapshot" });
					if (event?.type === "status" && event.status !== undefined) {
						if (unfinished.size === 0) repairingWithLiveStatus = false;
						else if (TERMINAL_STATUSES.has(event.status)) continue;
					}
				}
				if (event) {
					if (event.id && accumulator.isCompleted(event.id)) lastCompletedId = event.id;
					accumulator.markDelivered(event);
					yield event;
				}
			}
		} catch (error) {
			throwIfAborted(options.signal);
			if (!options.reconnect || !retryable(error) || retries >= RETRY_DELAYS.length) {
				// History HTTP errors include provider response bodies; do not expose them here.
				if (error instanceof ApiError) throw new SseTransportError("http", error.statusCode);
				throw error;
			}
		} finally {
			controller.abort();
			queue?.clear();
			await pump;
			options.signal?.removeEventListener("abort", abort);
		}
		recover = true;
		await abortableDelay(RETRY_DELAYS[retries++]!, options.signal);
	}
}

function trackUnfinished(ids: Set<string>, id: string): void {
	if (!ids.has(id) && ids.size >= MAX_BUFFERED_FRAMES) {
		throw new UserError("Session unfinished event recovery buffer exceeded its limit.");
	}
	ids.add(id);
}

function retryable(error: unknown): boolean {
	return error instanceof SseTransportError
		? error.retryable
		: error instanceof ApiError && (error.statusCode === 429 || error.statusCode >= 500);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Session event stream cancelled.", "AbortError");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new DOMException("Session event stream cancelled.", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

class FrameQueue {
	private items: { raw: RawEvent; bytes: number }[] = [];
	private readonly failureSignal = deferred();
	readonly failurePromise = this.failureSignal.promise;
	constructor() {
		void this.failurePromise.catch(() => {});
	}
	private bytes = 0;
	private failure: unknown;
	private failed = false;
	private wake?: () => void;

	push(raw: RawEvent): void {
		const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
		if (this.items.length >= MAX_BUFFERED_FRAMES || this.bytes + bytes > MAX_BUFFERED_BYTES) {
			throw new UserError("Session event recovery buffer exceeded its limit.");
		}
		this.items.push({ raw, bytes });
		this.bytes += bytes;
		this.wake?.();
	}

	fail(error: unknown): void {
		if (this.failed) return;
		this.failure = error;
		this.failed = true;
		this.failureSignal.reject(error);
		this.wake?.();
	}
	clear(): void {
		this.items = [];
		this.bytes = 0;
	}
	async next(): Promise<RawEvent> {
		while (!this.items.length) {
			if (this.failed) throw this.failure;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = undefined;
		}
		const item = this.items.shift()!;
		this.bytes -= item.bytes;
		return item.raw;
	}
}

async function waitForHistory<T>(
	pending: Promise<T>,
	queue: FrameQueue,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: () => void = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new DOMException("Session event stream cancelled.", "AbortError"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => reject(new SseTransportError("connect-timeout")), timeoutMs);
	});
	try {
		// The failure promise can only reject, never resolve; mapping preserves the result type.
		return await Promise.race([
			pending,
			queue.failurePromise.then(() => {
				throw new SseTransportError("unexpected-eof");
			}),
			stopped,
		]);
	} catch (error) {
		if (error instanceof TypeError) throw new SseTransportError("network");
		if (error instanceof SyntaxError) throw new SseTransportError("protocol");
		throw error;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

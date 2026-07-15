/**
 * In-memory event buffer with multicast support.
 *
 * When a session starts, we create a buffer that collects provider session events from the
 * provider's AsyncIterable stream. SSE clients can subscribe and receive both
 * replayed historical events and real-time new events.
 *
 * Lifecycle:
 *  - Created when startSession / sendMessage begins consuming a stream.
 *  - Marked "done" when the stream ends (success or error).
 *  - Evicted after BUFFER_TTL_MS to avoid unbounded memory growth.
 */
import { isTerminalSessionStatus, type ProviderSessionEvent } from "@openagentpack/sdk";

export interface SessionEventBuffer {
	readonly sessionId: string;
	/** All events received so far (append-only during streaming). */
	readonly events: ProviderSessionEvent[];
	/** Whether the underlying provider stream has ended. */
	done: boolean;
	/** If the stream ended with an error, store it here. */
	error?: string;
	/** Epoch of last event or stream end, used for TTL eviction. */
	lastActivity: number;
}

type BufferListener = (event: ProviderSessionEvent | null) => void;

/** How long to keep a completed buffer in memory (5 minutes). */
const BUFFER_TTL_MS = 5 * 60 * 1000;
/** Max number of buffers to keep (prevent memory leaks from zombie sessions). */
const MAX_BUFFERS = 50;

const buffers = new Map<string, SessionEventBuffer>();
const listeners = new Map<string, Set<BufferListener>>();

/**
 * Create a new event buffer for a session and start consuming the provider stream.
 * Returns the buffer immediately (events will be populated asynchronously).
 */
export function createEventBuffer(
	sessionId: string,
	stream: AsyncIterable<ProviderSessionEvent>,
	seed: ProviderSessionEvent[] = [],
): SessionEventBuffer {
	// Evict old buffers if at capacity
	evictStaleBuffers();

	const buffer: SessionEventBuffer = {
		sessionId,
		events: [...seed],
		done: false,
		lastActivity: Date.now(),
	};
	buffers.set(sessionId, buffer);
	listeners.set(sessionId, new Set());

	// Start consuming the stream in the background
	void consumeStream(sessionId, buffer, stream);

	return buffer;
}

/**
 * Seed a buffer for an already-terminal session: events are the full history and no live
 * stream is attached. Lets /stream replay a completed session statelessly after a server
 * restart / eviction without depending on the provider's stream to close on its own.
 */
export function seedCompletedBuffer(sessionId: string, events: ProviderSessionEvent[]): SessionEventBuffer {
	evictStaleBuffers();
	const buffer: SessionEventBuffer = {
		sessionId,
		events: [...events],
		done: true,
		lastActivity: Date.now(),
	};
	buffers.set(sessionId, buffer);
	listeners.set(sessionId, new Set());
	return buffer;
}

/**
 * Get an existing buffer (or undefined if not found / already evicted).
 */
export function getEventBuffer(sessionId: string): SessionEventBuffer | undefined {
	return buffers.get(sessionId);
}

/**
 * Subscribe to real-time events for a session.
 * The listener receives each new provider session event, or `null` when the stream ends.
 * Returns an unsubscribe function.
 */
export function subscribeEvents(sessionId: string, listener: BufferListener): () => void {
	let subs = listeners.get(sessionId);
	if (!subs) {
		subs = new Set();
		listeners.set(sessionId, subs);
	}
	subs.add(listener);

	return () => {
		subs!.delete(listener);
		if (subs!.size === 0) {
			listeners.delete(sessionId);
		}
	};
}

// --- Internal ---

async function consumeStream(
	sessionId: string,
	buffer: SessionEventBuffer,
	stream: AsyncIterable<ProviderSessionEvent>,
): Promise<void> {
	// De-dupe live events against any seeded history (and against themselves) by event id,
	// so a reconstructed buffer doesn't double-emit events that the history replay already holds.
	const seen = new Set<string>();
	for (const event of buffer.events) if (event.id) seen.add(event.id);
	// Explicit iterator so we can close the upstream SSE in `finally`: the bailian provider stream
	// keeps emitting empty keepalive frames after the session reaches a terminal status and never
	// ends on its own, so we must stop consuming and cancel it ourselves.
	const iterator = stream[Symbol.asyncIterator]();
	try {
		while (true) {
			const { value: event, done } = await iterator.next();
			if (done) break;
			// Drop keepalive / partial frames that carry no provider event type (raw_type "").
			if (!event.raw_type) continue;
			if (event.id) {
				if (seen.has(event.id)) continue;
				seen.add(event.id);
			}
			buffer.events.push(event);
			buffer.lastActivity = Date.now();
			broadcast(sessionId, event);
			// End the buffer as soon as the session reaches a terminal status, rather than waiting
			// for a stream that won't close itself.
			if (event.type === "status" && isTerminalSessionStatus(event.status)) break;
		}
	} catch (err) {
		buffer.error = err instanceof Error ? err.message : "Stream ended unexpectedly";
	} finally {
		try {
			await iterator.return?.();
		} catch {
			// Ignore errors from cancelling the upstream stream.
		}
		if (!buffer.done) {
			buffer.done = true;
			buffer.lastActivity = Date.now();
			broadcast(sessionId, null); // Signal completion to subscribers
		}
	}
}

function broadcast(sessionId: string, event: ProviderSessionEvent | null): void {
	const subs = listeners.get(sessionId);
	if (!subs) return;
	for (const listener of subs) {
		try {
			listener(event);
		} catch {
			// Ignore listener errors
		}
	}
}

function evictStaleBuffers(): void {
	const now = Date.now();
	// First pass: remove expired
	for (const [id, buffer] of buffers) {
		if (buffer.done && now - buffer.lastActivity > BUFFER_TTL_MS) {
			buffers.delete(id);
			listeners.delete(id);
		}
	}
	// Second pass: if still over capacity, remove oldest completed
	if (buffers.size >= MAX_BUFFERS) {
		const completed = [...buffers.entries()]
			.filter(([, b]) => b.done)
			.sort(([, a], [, b]) => a.lastActivity - b.lastActivity);
		while (buffers.size >= MAX_BUFFERS && completed.length > 0) {
			const [id] = completed.shift()!;
			buffers.delete(id);
			listeners.delete(id);
		}
	}
}

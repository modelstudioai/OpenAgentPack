import { describe, expect, test } from "bun:test";
import type { ProviderSessionEvent } from "@openagentpack/sdk";

import { createEventBuffer, subscribeEvents } from "../src/services/sessions/event-buffer";

function ev(partial: Partial<ProviderSessionEvent>): ProviderSessionEvent {
	return { type: "unknown", raw_type: "", raw: {}, ...partial };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("event-buffer consumeStream", () => {
	test("ends the buffer on terminal status and cancels the upstream stream", async () => {
		let returnCalled = false;
		// Mimics the bailian SSE: emits a keepalive frame with empty raw_type, then real events,
		// reaches a terminal status, and would keep emitting keepalive frames forever if not cancelled.
		async function* fakeStream(): AsyncGenerator<ProviderSessionEvent> {
			try {
				yield ev({ type: "unknown", raw_type: "" });
				yield ev({ type: "message", raw_type: "message", role: "user", content: "hi", id: "u1" });
				yield ev({ type: "status", raw_type: "session_status", status: "running", id: "s1" });
				yield ev({ type: "message", raw_type: "message", role: "assistant", content: "hello", id: "a1" });
				yield ev({ type: "status", raw_type: "session_status", status: "idle", id: "s2" });
				while (true) {
					await new Promise((resolve) => setTimeout(resolve, 5));
					yield ev({ type: "unknown", raw_type: "" });
				}
			} finally {
				returnCalled = true;
			}
		}

		const received: (ProviderSessionEvent | null)[] = [];
		const buffer = createEventBuffer("test-terminal", fakeStream());
		subscribeEvents("test-terminal", (event) => received.push(event));

		await waitFor(() => buffer.done);

		expect(buffer.done).toBe(true);
		expect(buffer.error).toBeUndefined();
		// Upstream stream was cancelled (its finally ran) rather than left consuming keepalives.
		expect(returnCalled).toBe(true);

		// Empty-raw_type keepalive frames are excluded; only the 4 real events remain.
		expect(buffer.events.map((e) => e.id)).toEqual(["u1", "s1", "a1", "s2"]);
		expect(buffer.events.every((e) => e.raw_type !== "")).toBe(true);

		// Subscriber saw the 4 real events followed by exactly one completion signal.
		const nulls = received.filter((e) => e === null);
		expect(nulls).toHaveLength(1);
		expect(received[received.length - 1]).toBeNull();
		expect(received.filter((e) => e !== null)).toHaveLength(4);
	});

	test("de-dupes against seeded history and drops empty frames on a stream that ends naturally", async () => {
		const seed: ProviderSessionEvent[] = [
			ev({ type: "message", raw_type: "message", role: "user", content: "hi", id: "a1" }),
		];
		async function* fakeStream(): AsyncGenerator<ProviderSessionEvent> {
			yield ev({ type: "unknown", raw_type: "" }); // dropped: empty raw_type
			yield ev({ type: "message", raw_type: "message", role: "user", content: "hi", id: "a1" }); // dup of seed
			yield ev({ type: "message", raw_type: "message", role: "assistant", content: "yo", id: "b1" });
		}

		const received: (ProviderSessionEvent | null)[] = [];
		const buffer = createEventBuffer("test-dedup", fakeStream(), seed);
		subscribeEvents("test-dedup", (event) => received.push(event));

		await waitFor(() => buffer.done);

		expect(buffer.events.map((e) => e.id)).toEqual(["a1", "b1"]);
		expect(buffer.done).toBe(true);
		expect(received.filter((e) => e === null)).toHaveLength(1);
		// Only the new (non-seed, non-dup, non-empty) event is broadcast live.
		expect(received.filter((e) => e !== null).map((e) => (e as ProviderSessionEvent).id)).toEqual(["b1"]);
	});
});

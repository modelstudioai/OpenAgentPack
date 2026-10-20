import { afterEach, expect, test } from "bun:test";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

const BASE = "https://bailian.test/api/v1/agentstudio";
const encoder = new TextEncoder();
afterEach(() => setDefaultFetch(undefined));

function adapter(): BailianAdapter {
	return new BailianAdapter("test-secret-key", undefined, BASE);
}

function message(id: string, text = id, status = "completed"): Record<string, unknown> {
	return { object: "message", id, type: "message", role: "assistant", status, content: [{ type: "text", text }] };
}

function feed(initial: Record<string, unknown>[] = [], closed = false) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				for (const item of initial) value.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
				if (closed) value.close();
			},
			cancel() {
				cancelled = true;
			},
		}),
	);
	return {
		response,
		push: (raw: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(raw)}\n\n`)),
		close: () => controller.close(),
		cancelled: () => cancelled,
	};
}

function iterator(options: Parameters<BailianAdapter["streamSessionEvents"]>[1] = {}) {
	return adapter().streamSessionEvents("session-test", options)[Symbol.asyncIterator]();
}

async function take(stream: AsyncIterator<ProviderSessionEvent>, count: number): Promise<ProviderSessionEvent[]> {
	const events: ProviderSessionEvent[] = [];
	for (let index = 0; index < count; index += 1) {
		const next = await stream.next();
		if (next.done) throw new Error("Unexpected end of test stream");
		events.push(next.value);
	}
	return events;
}

function url(input: Parameters<FetchLike>[0]): URL {
	return new URL(input instanceof Request ? input.url : input.toString());
}

function abortablePending(signal?: AbortSignal | null): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const abort = () => reject(new DOMException("Cancelled test request", "AbortError"));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

test("Bailian legacy defaults keep complete-event mapping and omit new query parameters", async () => {
	const requests: URL[] = [];
	setDefaultFetch(async (input) => {
		requests.push(url(input));
		return feed([message("one")], true).response;
	});
	const stream = iterator();
	const [event] = await take(stream, 1);
	expect(event?.snapshot).toBeUndefined();
	expect(event?.content).toBe("one");
	expect((await stream.next()).done).toBe(true);
	expect(requests[0]?.search).toBe("");
});

test("Bailian explicit deltas produce cumulative snapshots and only send event_deltas[]", async () => {
	let request: URL | undefined;
	const frames = [
		message("one", "", "in_progress"),
		{ object: "content", msg_id: "one", type: "text", index: 0, delta: true, text: "你" },
		{ object: "content", msg_id: "one", type: "text", index: 0, delta: true, text: "好" },
		message("one", "你好"),
	];
	const source = feed(frames);
	setDefaultFetch(async (input) => {
		request = url(input);
		return source.response;
	});
	const stream = iterator({ event_deltas: ["message", "reasoning", "message"] });
	try {
		const events = await take(stream, 4);
		expect(events.map((event) => event.snapshot?.content?.[0]?.text)).toEqual(["", "你", "你好", "你好"]);
		expect(events.map((event) => event.id)).toEqual(["one", "one", "one", "one"]);
		expect(request?.searchParams.getAll("event_deltas[]")).toEqual(["message", "reasoning"]);
		expect([...request!.searchParams.keys()]).toEqual(["event_deltas[]", "event_deltas[]"]);
	} finally {
		await stream.return?.();
	}
	expect(source.cancelled()).toBe(true);
});

test("reconnect paginates more than 100 events with opaque cursors and deduplicates live overlap", async () => {
	const history = Array.from({ length: 102 }, (_, index) => message(`e${index.toString().padStart(3, "0")}`));
	const cursor = "opaque page + / = ?";
	const requests: URL[] = [];
	let connections = 0;
	const resumed = feed([history[101]!]);
	setDefaultFetch(async (input) => {
		const request = url(input);
		requests.push(request);
		if (request.pathname.endsWith("/stream"))
			return ++connections === 1 ? feed([history[0]!], true).response : resumed.response;
		if (!request.searchParams.has("page")) return Response.json({ data: history.slice(0, 100), next_page: cursor });
		expect(request.searchParams.get("page")).toBe(cursor);
		return Response.json({ data: history.slice(100), next_page: null });
	});
	const stream = iterator({ event_format: "snapshot", reconnect: true });
	try {
		const events = await take(stream, 102);
		resumed.push(message("e102"));
		events.push(...(await take(stream, 1)));
		expect(events.map((event) => event.id)).toEqual(
			Array.from({ length: 103 }, (_, index) => `e${index.toString().padStart(3, "0")}`),
		);
		expect(connections).toBe(2);
		const historyRequests = requests.filter((request) => !request.pathname.endsWith("/stream"));
		expect(historyRequests).toHaveLength(2);
		expect(
			historyRequests.every(
				(request) => request.searchParams.get("limit") === "100" && request.searchParams.get("order") === "asc",
			),
		).toBe(true);
		expect(requests.every((request) => !request.searchParams.has("after_id"))).toBe(true);
	} finally {
		await stream.return?.();
	}
});

test("recovery preserves delivered snapshot comparisons across paginated history eviction and live overlap", async () => {
	const state = (value: string) => ({
		object: "message",
		id: "state",
		type: "session_status",
		status: "completed",
		content: [{ type: "data", data: { session_status: value } }],
	});
	const history = [
		...Array.from({ length: 1024 }, (_, index) => message(`old-${index}`)),
		state("idle"),
		message("marker"),
		message("answer", "final answer"),
	];
	const resumed = feed([state("idle"), message("answer", "final answer"), message("tail")]);
	let connections = 0;
	let pages = 0;
	setDefaultFetch(async (input) => {
		const request = url(input);
		if (request.pathname.endsWith("/stream"))
			return ++connections === 1 ? feed([state("running"), message("marker")], true).response : resumed.response;
		pages++;
		const offset = Number(request.searchParams.get("page") ?? "0");
		return Response.json({
			data: history.slice(offset, offset + 100),
			next_page: offset + 100 < history.length ? String(offset + 100) : null,
		});
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal });
	const guard = setTimeout(() => abort.abort(), 1500);
	try {
		const events = await take(stream, 5);
		expect(events.map((event) => [event.id, event.status])).toEqual([
			["state", "running"],
			["marker", undefined],
			["answer", undefined],
			["state", "idle"],
			["tail", undefined],
		]);
		expect(connections).toBe(2);
		expect(pages).toBe(11);
	} finally {
		clearTimeout(guard);
		abort.abort();
		await stream.return?.();
	}
});

test("initial after_id history does not make skipped status IDs eligible for later recovery", async () => {
	const state = (value: string) => ({
		object: "message",
		id: "old-state",
		type: "session_status",
		status: "completed",
		content: [{ type: "data", data: { session_status: value } }],
	});
	const first = feed();
	const resumed = feed([state("idle"), message("tail")]);
	let connections = 0;
	setDefaultFetch(async (input) => {
		if (url(input).pathname.endsWith("/stream")) return ++connections === 1 ? first.response : resumed.response;
		return Response.json({
			data: [state(connections === 1 ? "running" : "idle"), message("marker"), message("first")],
			next_page: null,
		});
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", after_id: "marker", reconnect: true, signal: abort.signal });
	const guard = setTimeout(() => abort.abort(), 1500);
	try {
		expect((await stream.next()).value?.id).toBe("first");
		first.close();
		expect((await stream.next()).value?.id).toBe("tail");
		expect(connections).toBe(2);
	} finally {
		clearTimeout(guard);
		abort.abort();
		await stream.return?.();
	}
});

for (const latestState of ["idle", "running"]) {
	test(`history retry preserves the latest ${latestState} status without losing or replaying stale idle`, async () => {
		const state = (value: string) => ({
			object: "message",
			id: "state",
			type: "session_status",
			status: "completed",
			content: [{ type: "data", data: { session_status: value } }],
		});
		const oldHistory =
			latestState === "running" ? Array.from({ length: 1024 }, (_, index) => message(`old-${index}`)) : [];
		let connections = 0;
		let pages = 0;
		setDefaultFetch(async (input) => {
			const request = url(input);
			if (request.pathname.endsWith("/stream")) {
				connections++;
				if (connections === 1) return feed([state("running"), message("marker")], true).response;
				return feed(connections === 2 ? [] : [state(latestState), message("answer"), message("tail")]).response;
			}
			pages++;
			if (request.searchParams.get("page") === "answer-page")
				return connections === 2
					? new Response("temporarily unavailable", { status: 503 })
					: Response.json({ data: [message("answer")], next_page: null });
			const history = [...oldHistory, state(connections === 2 ? "idle" : latestState), message("marker")];
			const offset = Number(request.searchParams.get("page") ?? "0");
			return Response.json({
				data: history.slice(offset, offset + 100),
				next_page: offset + 100 < history.length ? String(offset + 100) : "answer-page",
			});
		});
		const abort = new AbortController();
		const stream = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal });
		const guard = setTimeout(() => abort.abort(), 2000);
		try {
			const events = await take(stream, latestState === "idle" ? 5 : 4);
			expect(events.map((event) => [event.id, event.status])).toEqual([
				["state", "running"],
				["marker", undefined],
				["answer", undefined],
				...(latestState === "idle" ? [["state", latestState]] : []),
				["tail", undefined],
			]);
			expect(connections).toBe(3);
			expect(pages).toBe(latestState === "running" ? 24 : 4);
		} finally {
			clearTimeout(guard);
			abort.abort();
			await stream.return?.();
		}
	});
}

for (const scenario of ["missing-marker", "repeated-cursor", "missing-cursor"] as const) {
	test(`history recovery rejects ${scenario} without retrying or leaking provider data`, async () => {
		let requests = 0;
		const source = feed();
		setDefaultFetch(async (input) => {
			requests++;
			if (url(input).pathname.endsWith("/stream")) return source.response;
			if (scenario === "repeated-cursor") return Response.json({ data: [], next_page: "same-cursor" });
			if (scenario === "missing-cursor") return Response.json({ data: [], has_more: true });
			return Response.json({ data: [message("other")], next_page: null });
		});
		const error = await iterator({ event_format: "snapshot", after_id: "marker", reconnect: true })
			.next()
			.catch((value) => value);
		expect(error.message).toContain(
			scenario === "missing-marker"
				? "marker was not found"
				: scenario === "repeated-cursor"
					? "repeated cursor"
					: "missing a pagination cursor",
		);
		expect(requests).toBe(scenario === "repeated-cursor" ? 3 : 2);
		expect(source.cancelled()).toBe(true);
	});
}

for (const scenario of ["auth", "malformed"] as const) {
	test(`snapshot stream does not retry ${scenario} failures`, async () => {
		let requests = 0;
		setDefaultFetch(async () => {
			requests++;
			return scenario === "auth"
				? new Response("provider-secret", { status: 401 })
				: new Response("data: secret-malformed\n\n");
		});
		const error = await iterator({ event_format: "snapshot", reconnect: true })
			.next()
			.catch((value) => value);
		expect(error).toMatchObject({ code: scenario === "auth" ? "http" : "protocol", retryable: false });
		expect(String(error)).not.toContain("secret");
		expect(requests).toBe(1);
	});
}

test("explicit abort during retry backoff stops before another connection", async () => {
	let requests = 0;
	let ready!: () => void;
	const connected = new Promise<void>((resolve) => {
		ready = resolve;
	});
	setDefaultFetch(async () => {
		requests++;
		return feed([], true).response;
	});
	const abort = new AbortController();
	const pending = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal, onReady: ready }).next();
	await connected;
	await new Promise((resolve) => setTimeout(resolve, 20));
	abort.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(requests).toBe(1);
});

test("explicit abort cancels history fetch and releases its live subscription", async () => {
	const source = feed();
	let querying!: () => void;
	const historyStarted = new Promise<void>((resolve) => {
		querying = resolve;
	});
	setDefaultFetch(async (input, init) => {
		if (url(input).pathname.endsWith("/stream")) return source.response;
		querying();
		return abortablePending(init?.signal);
	});
	const abort = new AbortController();
	const pending = iterator({ event_format: "snapshot", after_id: "marker", signal: abort.signal }).next();
	await historyStarted;
	abort.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(source.cancelled()).toBe(true);
});

test("abort discards buffered live snapshots and never reconnects", async () => {
	let drained!: () => void;
	const framesRead = new Promise<void>((resolve) => {
		drained = resolve;
	});
	let sent = false;
	let cancelled = false;
	let requests = 0;
	const response = new Response(
		new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (sent) {
						drained();
						return;
					}
					sent = true;
					controller.enqueue(
						encoder.encode(
							[message("first"), message("second")].map((raw) => `data: ${JSON.stringify(raw)}\n\n`).join(""),
						),
					);
				},
				cancel() {
					cancelled = true;
				},
			},
			// The next pull happens only after both frames have reached the subscription buffer.
			{ highWaterMark: 0 },
		),
	);
	setDefaultFetch(async () => {
		requests++;
		return response;
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal });
	try {
		expect((await stream.next()).value?.id).toBe("first");
		await framesRead;
		abort.abort();
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		await stream.return?.();
	}
	expect(cancelled).toBe(true);
	expect(requests).toBe(1);
});

test("abort stops a partially delivered history page and releases its live subscription", async () => {
	const source = feed();
	let requests = 0;
	setDefaultFetch(async (input) => {
		requests++;
		if (url(input).pathname.endsWith("/stream")) return source.response;
		return Response.json({ data: [message("marker"), message("first"), message("second")], next_page: "next" });
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", after_id: "marker", reconnect: true, signal: abort.signal });
	try {
		expect((await stream.next()).value?.id).toBe("first");
		abort.abort();
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		await stream.return?.();
	}
	expect(source.cancelled()).toBe(true);
	// Cancellation must neither advance pagination nor establish a replacement stream.
	expect(requests).toBe(2);
});

test("content completion before message completion cannot become the reconnect marker", async () => {
	let connections = 0;
	const partial = [
		message("one", "partial", "in_progress"),
		{ object: "content", msg_id: "one", index: 0, type: "text", delta: false, status: "completed", text: "full" },
	];
	const resumed = feed();
	setDefaultFetch(async (input) => {
		if (url(input).pathname.endsWith("/stream"))
			return ++connections === 1 ? feed(partial, true).response : resumed.response;
		return Response.json({ data: [message("one", "full")], next_page: null });
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal });
	const guard = setTimeout(() => abort.abort(), 1000);
	try {
		const events = await take(stream, 3);
		expect(events[2]?.snapshot?.metadata?.event_status).toBe("completed");
		expect(events[2]?.snapshot?.content?.[0]?.text).toBe("full");
	} finally {
		clearTimeout(guard);
		abort.abort();
		await stream.return?.();
	}
});

test("recovery buffer overflow interrupts a pending history request", async () => {
	const source = feed();
	let querying!: () => void;
	const historyStarted = new Promise<void>((resolve) => {
		querying = resolve;
	});
	setDefaultFetch(async (input, init) => {
		if (url(input).pathname.endsWith("/stream")) return source.response;
		querying();
		return abortablePending(init?.signal);
	});
	const abort = new AbortController();
	const pending = iterator({ event_format: "snapshot", after_id: "marker", signal: abort.signal })
		.next()
		.catch((value) => value);
	await historyStarted;
	for (let index = 0; index < 1025; index++) source.push(message(`overflow-${index}`));
	const guard = setTimeout(() => abort.abort(), 1000);
	try {
		const error = await pending;
		expect(error.message).toContain("buffer exceeded its limit");
	} finally {
		clearTimeout(guard);
		abort.abort();
	}
	expect(source.cancelled()).toBe(true);
});

test("recovery repairs an older partial message even when a newer message completed first", async () => {
	let connections = 0;
	const resumed = feed();
	setDefaultFetch(async (input) => {
		if (url(input).pathname.endsWith("/stream")) {
			connections++;
			return connections === 1
				? feed([message("older", "partial", "in_progress"), message("newer", "done")], true).response
				: resumed.response;
		}
		return Response.json({ data: [message("older", "repaired"), message("newer", "done")], next_page: null });
	});
	const abort = new AbortController();
	const stream = iterator({ event_format: "snapshot", reconnect: true, signal: abort.signal });
	const guard = setTimeout(() => abort.abort(), 1000);
	try {
		const events = await take(stream, 3);
		expect(events.map((event) => event.id)).toEqual(["older", "newer", "older"]);
		expect(events[2]?.snapshot?.content?.[0]?.text).toBe("repaired");
		expect(events[2]?.snapshot?.metadata?.event_status).toBe("completed");
	} finally {
		clearTimeout(guard);
		abort.abort();
		await stream.return?.();
	}
});

for (const scenario of ["auth", "malformed"] as const) {
	test(`history recovery does not retry ${scenario} responses or expose their contents`, async () => {
		let requests = 0;
		const source = feed();
		setDefaultFetch(async (input) => {
			requests++;
			if (url(input).pathname.endsWith("/stream")) return source.response;
			return scenario === "auth"
				? new Response("provider-secret", { status: 403 })
				: new Response("invalid secret JSON");
		});
		const error = await iterator({ event_format: "snapshot", after_id: "marker", reconnect: true })
			.next()
			.catch((value) => value);
		expect(error).toMatchObject({ code: scenario === "auth" ? "http" : "protocol", retryable: false });
		expect(String(error)).not.toContain("secret");
		expect(requests).toBe(2);
		expect(source.cancelled()).toBe(true);
	});
}

test("abort interrupts history even when the injected fetch ignores AbortSignal", async () => {
	const source = feed();
	let querying!: () => void;
	const historyStarted = new Promise<void>((resolve) => {
		querying = resolve;
	});
	setDefaultFetch(async (input) => {
		if (url(input).pathname.endsWith("/stream")) return source.response;
		querying();
		return new Promise(() => {});
	});
	const abort = new AbortController();
	const pending = iterator({ event_format: "snapshot", after_id: "marker", signal: abort.signal }).next();
	await historyStarted;
	abort.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(source.cancelled()).toBe(true);
});

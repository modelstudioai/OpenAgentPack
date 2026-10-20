import { afterEach, expect, test } from "bun:test";
import { ApiError, BaseApiClient, SseTransportError } from "../../src/internal/providers/base-client.ts";
import { SseParser } from "../../src/internal/providers/sse-parser.ts";

class TestClient extends BaseApiClient {
	protected baseUrl = "https://example.test";
	protected errorPrefix = "test";
	protected paginationStrategy = "page" as const;
	protected headers(): Record<string, string> {
		return { Authorization: "Bearer test-provider-key" };
	}
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = implementation as typeof fetch;
}

function byteStream(text: string, split = false): Response {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				else controller.enqueue(bytes);
				controller.close();
			},
		}),
	);
}

async function collect(stream: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
	const events: Record<string, unknown>[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

for (const ending of ["\n", "\r\n", "\r"]) {
	test(`SSE parser supports ${JSON.stringify(ending)} split across network chunks`, async () => {
		const frames = [
			": connected",
			"",
			"event: heartbeat",
			"data: ignored heartbeat payload",
			"",
			"id: transport-id",
			'data: {"object":"message",',
			'data: "text":"你好 🌍"}',
			"",
			"",
		].join(ending);
		mockFetch(async () => byteStream(frames, true));
		const stream = new TestClient().sse("/events", { strict: true });
		expect((await stream.next()).value).toEqual({ object: "message", text: "你好 🌍" });
		await expect(stream.next()).rejects.toMatchObject({ code: "unexpected-eof", retryable: true });
	});
}

test("pure parser keeps transport IDs separate, ignores unknown fields and applies SSE value whitespace", () => {
	const parser = new SseParser();
	expect(
		parser.push(": comment\r\nretry: 100\r\nid: ignored\0id\r\nevent: update\r\ndata:  one\r\ndata: two\r\n\r\n"),
	).toEqual([{ event: "update", data: " one\ntwo", id: undefined }]);
	expect(parser.push("data\n\n")).toEqual([{ data: "", event: undefined, id: undefined }]);
});

test("legacy SSE preserves identity fallback, tolerant malformed frames and natural EOF", async () => {
	mockFetch(async () =>
		byteStream('data: broken\n\nid: transport\ndata: {"text":"ok"}\n\nid: ignored\ndata: {"id":"message"}\n\n'),
	);
	expect(await collect(new TestClient().sse("/events"))).toEqual([{ id: "transport", text: "ok" }, { id: "message" }]);
});

for (const json of ["broken", "null", "[]", '"text"']) {
	test(`strict SSE rejects invalid event ${json} without leaking frame contents`, async () => {
		mockFetch(async () => byteStream(`data: ${json}\n\n`));
		const error = await new TestClient()
			.sse("/events", { strict: true })
			.next()
			.catch((value) => value);
		expect(error).toBeInstanceOf(SseTransportError);
		expect(error).toMatchObject({ code: "protocol", retryable: false });
		expect(error.message).toBe("SSE response contains an invalid event");
	});
}

test("strict SSE rejects invalid UTF-8 instead of silently altering content", async () => {
	mockFetch(async () => new Response(new Uint8Array([0xff])));
	await expect(new TestClient().sse("/events", { strict: true }).next()).rejects.toMatchObject({ code: "protocol" });
});

test("onReady runs before a business frame and iterator return aborts and cancels the response", async () => {
	let source!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	let requestSignal: AbortSignal | undefined;
	mockFetch(async (_input, init) => {
		requestSignal = init?.signal ?? undefined;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					source = controller;
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
	});
	let connected!: () => void;
	const ready = new Promise<void>((resolve) => {
		connected = resolve;
	});
	const stream = new TestClient().sse("/events", { strict: true, onReady: connected });
	const first = stream.next();
	await ready;
	expect(cancelled).toBe(false);
	source.enqueue(new TextEncoder().encode('data: {"id":"msg"}\n\n'));
	expect((await first).value).toEqual({ id: "msg" });
	await stream.return(undefined);
	expect(cancelled).toBe(true);
	expect(requestSignal?.aborted).toBe(true);
});

for (const status of [400, 401, 403, 429, 500, 503]) {
	test(`strict HTTP ${status} exposes safe status and retry classification only`, async () => {
		let ready = false;
		mockFetch(async () => new Response("provider-secret-key sensitive body", { status }));
		const error = await new TestClient()
			.sse("/events?key=secret-url", {
				strict: true,
				onReady: () => {
					ready = true;
				},
			})
			.next()
			.catch((value) => value);
		expect(error).toMatchObject({ code: "http", statusCode: status, retryable: status === 429 || status >= 500 });
		expect(String(error)).not.toContain("secret");
		expect(error.responseBody).toBeUndefined();
		expect(error.cause).toBeUndefined();
		expect(ready).toBe(false);
	});
}

test("legacy HTTP failure retains ApiError status compatibility", async () => {
	mockFetch(async () => new Response("missing", { status: 404 }));
	const error = await new TestClient()
		.sse("/events")
		.next()
		.catch((value) => value);
	expect(error).toBeInstanceOf(ApiError);
	expect(error.statusCode).toBe(404);
});

test("strict network failure strips provider exception text", async () => {
	mockFetch(async () => {
		throw new Error("key=secret-provider-key");
	});
	const error = await new TestClient()
		.sse("/events", { strict: true })
		.next()
		.catch((value) => value);
	expect(error).toMatchObject({ code: "network", retryable: true });
	expect(String(error)).not.toContain("secret-provider-key");
	expect(error.cause).toBeUndefined();
});

test("abort before connecting does not make a request or expose the abort reason", async () => {
	let requests = 0;
	mockFetch(async () => {
		requests += 1;
		return byteStream("");
	});
	const abort = new AbortController();
	abort.abort(new Error("secret abort reason"));
	const error = await new TestClient()
		.sse("/events", { strict: true, signal: abort.signal })
		.next()
		.catch((value) => value);
	expect(error.name).toBe("AbortError");
	expect(String(error)).not.toContain("secret");
	expect(requests).toBe(0);
});

test("abort cancels a pending fetch even when custom fetch ignores its signal", async () => {
	let requested!: () => void;
	const started = new Promise<void>((resolve) => {
		requested = resolve;
	});
	mockFetch(() => {
		requested();
		return new Promise(() => {});
	});
	const abort = new AbortController();
	const next = new TestClient().sse("/events", { strict: true, signal: abort.signal }).next();
	await started;
	abort.abort();
	await expect(next).rejects.toMatchObject({ name: "AbortError" });
});

test("abort cancels a pending read and releases the response", async () => {
	let cancelled = false;
	let connected!: () => void;
	const ready = new Promise<void>((resolve) => {
		connected = resolve;
	});
	mockFetch(
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const abort = new AbortController();
	const next = new TestClient().sse("/events", { strict: true, signal: abort.signal, onReady: connected }).next();
	await ready;
	abort.abort();
	await expect(next).rejects.toMatchObject({ name: "AbortError" });
	expect(cancelled).toBe(true);
});

test("connection and idle timeouts are classified and cancel the request", async () => {
	let signal: AbortSignal | null | undefined;
	mockFetch((_input, init) => {
		signal = init?.signal;
		return new Promise(() => {});
	});
	await expect(new TestClient().sse("/events", { strict: true, connectTimeoutMs: 5 }).next()).rejects.toMatchObject({
		code: "connect-timeout",
		retryable: true,
	});
	expect(signal?.aborted).toBe(true);
	let cancelled = false;
	mockFetch(
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	await expect(new TestClient().sse("/events", { strict: true, idleTimeoutMs: 5 }).next()).rejects.toMatchObject({
		code: "idle-timeout",
		retryable: true,
	});
	expect(cancelled).toBe(true);
});

test("comment and heartbeat bytes keep a quiet subscription active", async () => {
	let source!: ReadableStreamDefaultController<Uint8Array>;
	mockFetch(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						source = controller;
					},
				}),
			),
	);
	const stream = new TestClient().sse("/events", { strict: true, idleTimeoutMs: 60 });
	const next = stream.next();
	for (let index = 0; index < 5; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		source.enqueue(new TextEncoder().encode(": heartbeat\n\nevent: heartbeat\ndata: {}\n\n"));
	}
	source.enqueue(new TextEncoder().encode('data: {"id":"msg"}\n\n'));
	expect((await next).value).toEqual({ id: "msg" });
	await stream.return(undefined);
});

test("strict streams without a response body fail before readiness", async () => {
	let ready = false;
	mockFetch(async () => new Response(null, { status: 204 }));
	await expect(
		new TestClient()
			.sse("/events", {
				strict: true,
				onReady: () => {
					ready = true;
				},
			})
			.next(),
	).rejects.toMatchObject({ code: "protocol", retryable: false });
	expect(ready).toBe(false);
});

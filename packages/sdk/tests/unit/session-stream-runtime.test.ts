import { afterEach, describe, expect, test } from "bun:test";
import { streamMessageEvents } from "../../src/internal/core/session-runtime.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import { setDefaultFetch } from "../../src/internal/transport.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

afterEach(() => setDefaultFetch(undefined));

function adapter() {
	return new BailianAdapter("test", undefined, "https://bailian.example.test");
}
function status(id: string, value: string, stop_reason?: unknown) {
	return {
		object: "message",
		type: "session_status",
		status: "completed",
		id,
		content: [{ type: "data", data: { session_status: value, stop_reason } }],
	};
}
function encode(raw: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`);
}

describe("streaming send lifecycle", () => {
	test("awaits the HTTP subscription before POST, delivers cumulative updates, and stops on idle", async () => {
		const calls: string[] = [];
		let source!: ReadableStreamDefaultController<Uint8Array>;
		let connect!: () => void;
		const gate = new Promise<void>((resolve) => {
			connect = resolve;
		});
		let cancel = false;
		setDefaultFetch(async (_input, init) => {
			if (init?.method === "POST") {
				calls.push("send");
				source.enqueue(encode(status("running", "running")));
				source.enqueue(
					encode({ object: "message", id: "m", type: "message", role: "assistant", status: "in_progress" }),
				);
				source.enqueue(encode({ object: "content", msg_id: "m", index: 0, type: "text", delta: true, text: "你" }));
				source.enqueue(encode({ object: "content", msg_id: "m", index: 0, type: "text", delta: true, text: "好" }));
				source.enqueue(
					encode({
						object: "message",
						id: "m",
						type: "message",
						status: "completed",
						content: [{ type: "text", text: "你好" }],
					}),
				);
				source.enqueue(encode(status("idle", "idle")));
				return Response.json({ id: "user" });
			}
			calls.push("connecting");
			await gate;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						source = controller;
					},
					cancel() {
						cancel = true;
					},
				}),
			);
		});
		const events: ProviderSessionEvent[] = [];
		const reading = (async () => {
			for await (const event of streamMessageEvents(adapter(), "s", "hi", {
				event_deltas: ["message"],
				onReady: () => calls.push("ready"),
			}))
				events.push(event);
		})();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toEqual(["connecting"]);
		connect();
		await reading;
		expect(calls).toEqual(["connecting", "ready", "send"]);
		expect(events.filter((event) => event.id === "m").map((event) => event.snapshot?.content?.[0]?.text)).toEqual([
			undefined,
			"你",
			"你好",
			"你好",
		]);
		expect(events.at(-1)?.status).toBe("idle");
		expect(cancel).toBe(true);
	});

	test("connection failure and pre-cancellation never send a message", async () => {
		let posts = 0;
		setDefaultFetch(async (_input, init) => {
			if (init?.method === "POST") posts++;
			return new Response("private provider error", { status: 401 });
		});
		const stream = streamMessageEvents(adapter(), "s", "hi", { event_format: "snapshot" })[Symbol.asyncIterator]();
		await expect(stream.next()).rejects.toThrow("HTTP 401");
		const controller = new AbortController();
		controller.abort();
		const stopped = streamMessageEvents(adapter(), "s", "hi", { event_format: "snapshot", signal: controller.signal })[
			Symbol.asyncIterator
		]();
		await expect(stopped.next()).rejects.toMatchObject({ name: "AbortError" });
		expect(posts).toBe(0);
	});

	test("POST failure cancels the established subscription and does not retry the send", async () => {
		let cancelled = false;
		let posts = 0;
		setDefaultFetch(async (_input, init) => {
			if (init?.method === "POST") {
				posts++;
				return new Response("send failed", { status: 503 });
			}
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			);
		});
		const stream = streamMessageEvents(adapter(), "s", "hi", { event_format: "snapshot", reconnect: true })[
			Symbol.asyncIterator
		]();
		await expect(stream.next()).rejects.toThrow("503");
		expect(posts).toBe(1);
		expect(cancelled).toBe(true);
	});

	test("requires_action is delivered intact and ends the single-turn iterator without resending", async () => {
		let source!: ReadableStreamDefaultController<Uint8Array>;
		let posts = 0;
		setDefaultFetch(async (_input, init) => {
			if (init?.method === "POST") {
				posts++;
				source.enqueue(encode(status("running", "running")));
				source.enqueue(encode(status("approval", "idle", { type: "requires_action", call_ids: ["call-1"] })));
				return Response.json({ id: "user" });
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						source = controller;
					},
				}),
			);
		});
		const events = [];
		for await (const event of streamMessageEvents(adapter(), "s", "hi", { event_format: "snapshot" }))
			events.push(event);
		expect(events.at(-1)?.snapshot?.metadata?.stop_reason).toEqual({ type: "requires_action", call_ids: ["call-1"] });
		expect(posts).toBe(1);
	});

	test("abort stops observation while POST is still pending, without sending twice", async () => {
		const controller = new AbortController();
		let posted!: () => void;
		const sent = new Promise<void>((resolve) => {
			posted = resolve;
		});
		let posts = 0;
		let cancelled = false;
		setDefaultFetch(async (_input, init) => {
			if (init?.method === "POST") {
				posts++;
				posted();
				return new Promise<Response>(() => {});
			}
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			);
		});
		const iterator = streamMessageEvents(adapter(), "s", "hi", { event_format: "snapshot", signal: controller.signal })[
			Symbol.asyncIterator
		]();
		const pending = iterator.next();
		await sent;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(posts).toBe(1);
		expect(cancelled).toBe(true);
	});

	test("unsupported providers reject explicit Bailian mode before sending", () => {
		const claude = new ClaudeAdapter("test");
		expect(() => streamMessageEvents(claude, "s", "hi", { event_deltas: ["message"] })).toThrow("only by Bailian");
	});
});

function message(id: string, role: string, text: string) {
	return { object: "message", type: "message", id, role, status: "completed", content: [{ type: "text", text }] };
}

describe("single-turn snapshot recovery", () => {
	for (const phase of ["before-first-event", "at-marker", "before-marker"] as const) {
		test(`recovers a changed status ${phase} after repairing the final answer`, async () => {
			const laterMarker = phase === "before-marker";
			const user = message("new-user", "user", "question");
			const running = status("current-status", "running");
			const idle = status("current-status", "idle", { type: "end_turn" });
			const marker = message("later-marker", "assistant", "working");
			const answer = message("answer", "assistant", "complete answer");
			let first!: ReadableStreamDefaultController<Uint8Array>;
			let connections = 0;
			let posts = 0;
			let pages = 0;
			let cancelled = false;
			setDefaultFetch(async (input, init) => {
				if (init?.method === "POST") {
					posts++;
					if (phase !== "before-first-event") {
						for (const raw of [
							running,
							...(laterMarker ? [marker] : []),
							{ ...answer, status: "in_progress", content: [{ type: "text", text: "partial" }] },
						])
							first.enqueue(encode(raw));
					}
					first.close();
					return Response.json({ id: user.id });
				}
				if (String(input).includes("/stream")) {
					connections++;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								if (connections === 1) first = controller;
								else for (const raw of [idle, answer]) controller.enqueue(encode(raw));
							},
							cancel() {
								cancelled = true;
							},
						}),
					);
				}
				pages++;
				return new URL(String(input)).searchParams.has("page")
					? Response.json({ data: [answer], next_page: null })
					: Response.json({
							data: [
								message("old-answer", "assistant", "previous turn"),
								status("old-status", "idle"),
								user,
								idle,
								...(laterMarker ? [marker] : []),
							],
							next_page: "final-answer",
						});
			});
			const controller = new AbortController();
			const guard = setTimeout(() => controller.abort(), 1500);
			const events: ProviderSessionEvent[] = [];
			try {
				for await (const event of streamMessageEvents(adapter(), "s", "question", {
					event_format: "snapshot",
					reconnect: true,
					signal: controller.signal,
				}))
					events.push(event);
			} finally {
				clearTimeout(guard);
				controller.abort();
			}
			expect(events.filter((event) => event.id === "current-status").map((event) => event.status)).toEqual(
				phase === "before-first-event" ? ["idle"] : ["running", "idle"],
			);
			expect(events.slice(-2).map((event) => [event.id, event.content, event.status])).toEqual([
				["answer", "complete answer", undefined],
				["current-status", undefined, "idle"],
			]);
			expect(events.some((event) => event.id?.startsWith("old-"))).toBe(false);
			expect(posts).toBe(1);
			expect(connections).toBe(2);
			expect(pages).toBe(2);
			expect(cancelled).toBe(true);
		});
	}

	const cases = [
		{ phase: "before-first-event", delivery: "live" },
		{ phase: "before-first-event", delivery: "history" },
		{ phase: "after-partial", delivery: "history" },
		{ phase: "after-running", delivery: "history" },
		{ phase: "initial-after-id", delivery: "history" },
	] as const;
	for (const { phase, delivery } of cases) {
		test(`${phase}: ignores the previous turn and completes from current ${delivery}`, async () => {
			const previous = [
				message("old-user", "user", "old question"),
				message("old-answer", "assistant", "OLD ANSWER"),
				status("old-idle", "idle", { type: "end_turn" }),
			];
			const user = message("new-user", "user", "new question");
			const running = status("new-running", "running");
			const answer = message("new-answer", "assistant", "NEW ANSWER");
			const idle = status("new-idle", "idle", { type: "end_turn" });
			const initial =
				phase === "after-running"
					? [running]
					: phase === "after-partial"
						? [{ ...answer, status: "in_progress", content: [{ type: "text", text: "NEW" }] }]
						: [];
			const history = [...previous, user, ...(delivery === "history" ? [running, answer, idle] : [])];
			let first!: ReadableStreamDefaultController<Uint8Array>;
			let posts = 0;
			let connections = 0;
			let historyRequests = 0;
			let cancelled = false;
			let resolvePosted!: () => void;
			const posted = new Promise<void>((resolve) => {
				resolvePosted = resolve;
			});
			setDefaultFetch(async (input, init) => {
				if (init?.method === "POST") {
					posts++;
					resolvePosted();
					if (phase !== "initial-after-id") {
						for (const raw of initial) first.enqueue(encode(raw));
						first.close(); // Natural EOF, without a synthetic done event.
					}
					return Response.json({ id: "new-user" });
				}
				if (String(input).includes("/stream")) {
					connections++;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								if (connections === 1) first = controller;
								else if (delivery === "live") {
									for (const raw of [running, answer, idle]) controller.enqueue(encode(raw));
								}
							},
							cancel() {
								cancelled = true;
							},
						}),
					);
				}
				historyRequests++;
				await posted;
				return Response.json({ data: history, next_page: null });
			});
			const events: ProviderSessionEvent[] = [];
			for await (const event of streamMessageEvents(adapter(), "s", "new question", {
				event_format: "snapshot",
				reconnect: true,
				...(phase === "initial-after-id" ? { after_id: "old-user" } : {}),
			}))
				events.push(event);
			expect(events.some((event) => event.id?.startsWith("old-"))).toBe(false);
			expect(events.filter((event) => event.id === "new-answer").at(-1)?.content).toBe("NEW ANSWER");
			expect(events.at(-1)?.id).toBe("new-idle");
			expect(events.filter((event) => event.id === "new-idle")).toHaveLength(1);
			expect(posts).toBe(1);
			expect(connections).toBe(phase === "initial-after-id" ? 1 : 2);
			expect(historyRequests).toBe(1);
			expect(cancelled).toBe(true);
		});
	}

	test("missing send identity fails recovery instead of returning a previous answer", async () => {
		let first!: ReadableStreamDefaultController<Uint8Array>;
		let posts = 0;
		let cancelled = false;
		setDefaultFetch(async (input, init) => {
			if (init?.method === "POST") {
				posts++;
				first.close();
				return Response.json({});
			}
			if (String(input).includes("/stream")) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							first = controller;
						},
						cancel() {
							cancelled = true;
						},
					}),
				);
			}
			return Response.json({
				data: [message("old-answer", "assistant", "OLD ANSWER"), status("old-idle", "idle")],
				next_page: null,
			});
		});
		const reading = (async () => {
			for await (const _event of streamMessageEvents(adapter(), "s", "hi", {
				event_format: "snapshot",
				reconnect: true,
			})) {
				throw new Error("Recovery must not deliver another turn's events.");
			}
		})();
		await expect(reading).rejects.toThrow("send response did not include an event id");
		expect(posts).toBe(1);
		expect(cancelled).toBe(true);
	});
});

for (const snapshot of [false, true]) {
	test(`${snapshot ? "snapshot live" : "legacy default"} send does not require a send event id or user echo`, async () => {
		let source!: ReadableStreamDefaultController<Uint8Array>;
		let posts = 0;
		const requests: string[] = [];
		const frames = [
			message("answer", "assistant", "answer"),
			status("idle", "idle"),
			message("after-idle", "assistant", "still listening"),
		];
		setDefaultFetch(async (input, init) => {
			if (init?.method === "POST") {
				posts++;
				for (const raw of frames) source.enqueue(encode(raw));
				source.close();
				return Response.json({});
			}
			requests.push(String(input));
			return new Response(
				new ReadableStream({
					start: (controller) => {
						source = controller;
					},
				}),
			);
		});
		const events: ProviderSessionEvent[] = [];
		for await (const event of streamMessageEvents(
			adapter(),
			"s",
			"hi",
			snapshot ? { event_format: "snapshot" } : undefined,
		))
			events.push(event);
		expect(events.map((event) => event.id)).toEqual(snapshot ? ["answer", "idle"] : ["answer", "idle", "after-idle"]);
		expect(events.every((event) => Boolean(event.snapshot) === snapshot)).toBe(true);
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]!).search).toBe("");
		expect(posts).toBe(1);
	});
}

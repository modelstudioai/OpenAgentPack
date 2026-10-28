import { describe, expect, test } from "bun:test";
import { createBailianSessionEventNormalizer } from "../../src/session-events.ts";

// Shapes observed on the BMA Session stream on 2026-10-28; IDs and content are synthetic.
const start = (id: string, type: string, fields = {}) => ({
	type: "event_start",
	event: { id, type, ...fields },
	object: "message",
	status: "in_progress",
});
const delta = (id: string, text: string, reasoning = false, index = 0) => ({
	type: "event_delta",
	event_id: id,
	delta: reasoning
		? { type: "reasoning_delta", index, reasoning: text }
		: { type: "content_delta", index, content: { type: "text", text } },
	object: "content",
	status: "in_progress",
});
const complete = (id: string, type: string, text: string) => ({
	object: "message",
	status: "completed",
	id,
	type,
	role: "assistant",
	thread_id: "thread-main",
	created_at: "2026-10-28T12:00:00.000Z",
	content: [{ type: "text", text }],
});

describe("public normalizer BMA mixed stream envelopes", () => {
	test("accumulates reasoning and message deltas, then accepts final identity and independent idle", () => {
		const normalizer = createBailianSessionEventNormalizer({ includeRaw: true });
		const initial = normalizer.push(start("reason", "reasoning"))!;
		expect(initial).toMatchObject({ event_id: "reason", type: "reasoning", metadata: { event_status: "in_progress" } });
		expect(initial.role).toBeUndefined();
		expect(initial.metadata?.thread_id).toBeUndefined();
		const raw = delta("reason", "想", true);
		const first = normalizer.push(raw)!;
		expect(first.content).toEqual([{ type: "text", text: "想" }]);
		expect(first.metadata?.raw).toEqual(raw);
		expect(normalizer.push(delta("reason", "想", true))?.content).toEqual([{ type: "text", text: "想想" }]);
		expect(first.content).toEqual([{ type: "text", text: "想" }]);
		expect(normalizer.push(complete("reason", "reasoning", "完整推理"))).toMatchObject({
			event_id: "reason",
			role: "assistant",
			content: [{ type: "text", text: "完整推理" }],
			metadata: { event_status: "completed", thread_id: "thread-main" },
		});
		normalizer.push(start("answer", "message"));
		expect(normalizer.push(delta("answer", "你"))?.content).toEqual([{ type: "text", text: "你" }]);
		expect(normalizer.push(delta("answer", "好"))?.content).toEqual([{ type: "text", text: "你好" }]);
		expect(normalizer.push(complete("answer", "message", "你好！"))?.content).toEqual([
			{ type: "text", text: "你好！" },
		]);
		expect(normalizer.push(delta("answer", "迟到"))).toBeUndefined();
		expect(
			normalizer.push({
				object: "message",
				status: "completed",
				id: "status",
				type: "session_status",
				content: [{ type: "data", data: { session_status: "idle", stop_reason: "end_turn" } }],
			})?.metadata,
		).toMatchObject({ status: "idle", stop_reason: "end_turn" });
	});

	test("buffers orphan deltas by event ID and index while retaining optional start fields", () => {
		const normalizer = createBailianSessionEventNormalizer();
		expect(normalizer.push(delta("message", "B", false, 1))).toBeUndefined();
		expect(normalizer.push(delta("reason", "", true))).toBeUndefined();
		expect(normalizer.push(start("reason", "reasoning"))?.content).toEqual([{ type: "text", text: "" }]);
		expect(
			normalizer.push({
				...start("message", "message", {
					role: "assistant",
					thread_id: "thread-child",
					created_at: "2026-10-28T12:00:00.000Z",
					metadata: { inner: true },
				}),
				metadata: { outer: true },
			}),
		).toMatchObject({
			event_id: "message",
			role: "assistant",
			created_at: "2026-10-28T12:00:00.000Z",
			metadata: { thread_id: "thread-child", outer: true, inner: true },
		});
		expect(normalizer.push(delta("message", "A"))?.content).toEqual([
			{ type: "text", text: "A" },
			{ type: "text", text: "B" },
		]);
	});

	test("history remains authoritative and stream envelopes cannot seed history", () => {
		const normalizer = createBailianSessionEventNormalizer();
		normalizer.seed(complete("final", "message", "history"));
		expect(normalizer.push(start("final", "message"))).toBeUndefined();
		expect(normalizer.push(delta("final", "older"))).toBeUndefined();
		expect(() => normalizer.seed(start("invalid", "message"))).toThrow("history must contain complete events");
		expect(() => normalizer.seed(delta("invalid", "older"))).toThrow("history must contain complete events");
		normalizer.seed({ ...complete("pending", "reasoning", "partial"), status: "in_progress" });
		expect(normalizer.push(start("pending", "reasoning"))).toBeUndefined();
		expect(normalizer.push(delta("pending", "tail", true))).toBeUndefined();
		expect(normalizer.push(complete("pending", "reasoning", "restored"))?.content).toEqual([
			{ type: "text", text: "restored" },
		]);
	});

	test("nested content fields survive both orphan buffering and direct deltas", () => {
		const normalizer = createBailianSessionEventNormalizer();
		const content = {
			type: "vendor_card",
			id: "block-id",
			event_id: "block-event",
			object: "vendor",
			status: "ready",
			delta: false,
			data: { text: "hello" },
			vendor: { enabled: true },
		};
		const frame = {
			...delta("message", "unused"),
			delta: { type: "content_delta", index: 0, content },
		};
		expect(normalizer.push(frame)).toBeUndefined();
		expect(normalizer.push(start("message", "message"))?.content).toEqual([content]);
		expect(normalizer.push(frame)?.content).toEqual([content]);
		expect(normalizer.push({ ...complete("message", "message", "unused"), content: [content] })?.content).toEqual([
			content,
		]);
	});

	test("rejects malformed and excessive envelopes without echoing provider content", () => {
		const normalizer = createBailianSessionEventNormalizer({ maxEntries: 1 });
		for (const frame of [
			start("", "reasoning"),
			{ ...start("m", "reasoning"), event: "secret-provider-body" },
			{ ...delta("m", "secret-provider-body"), event_id: "" },
			delta("m", "secret-provider-body", false, -1),
			{ ...delta("m", "secret-provider-body"), delta: { type: "reasoning_delta", index: 0, reasoning: 1 } },
		]) {
			try {
				normalizer.push(frame);
				throw new Error("Expected protocol rejection");
			} catch (error) {
				expect(error).toMatchObject({ code: "BAILIAN_EVENT_PROTOCOL_ERROR" });
				expect(String(error)).not.toContain("secret-provider-body");
			}
		}
		expect(normalizer.push(delta("orphan", "first"))).toBeUndefined();
		expect(() => normalizer.push(delta("orphan", "second"))).toThrow("orphan content buffer exceeded");
	});
});

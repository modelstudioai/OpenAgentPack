import { describe, expect, test } from "bun:test";
import { BailianEventAccumulator } from "../../src/internal/providers/bailian/event-accumulator.ts";

const start = (id: string, type = "message") => ({
	object: "message",
	id,
	type,
	role: "assistant",
	status: "in_progress",
});
const delta = (id: string, text: string, index = 0, append = true) => ({
	object: "content",
	msg_id: id,
	type: "text",
	text,
	index,
	delta: append,
	status: append ? "in_progress" : "completed",
});
const finish = (id: string, content?: unknown[]) => ({
	object: "message",
	id,
	status: "completed",
	...(content === undefined ? {} : { content }),
});

describe("Bailian cumulative snapshots", () => {
	test("appends repeated deltas, replaces snapshots, and does not mutate earlier outputs", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("m"));
		const first = stream.push(delta("m", "哈"))!;
		expect(stream.push(delta("m", "哈"))?.content).toBe("哈哈");
		const frame = delta("m", "你好", 0, false);
		const replaced = stream.push(frame)!;
		expect(replaced.content).toBe("你好");
		expect(replaced.raw).toBe(frame);
		expect(first.snapshot?.content?.[0]?.text).toBe("哈");
		expect(replaced.snapshot?.metadata?.event_status).toBe("in_progress");
		expect(stream.push(finish("m"))?.snapshot?.metadata?.event_status).toBe("completed");
		expect(stream.push(delta("m", "late"))).toBeUndefined();
		expect(stream.push(start("m"))).toBeUndefined();
	});

	test("explicit empty text and arrays clear content while omitted content preserves it", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("empty-text"));
		stream.push(delta("empty-text", "old"));
		expect(stream.push(delta("empty-text", "", 0, false))?.content).toBe("");
		expect(stream.push(finish("empty-text"))?.snapshot?.content).toEqual([{ type: "text", text: "" }]);
		stream.push(start("empty-array"));
		stream.push(delta("empty-array", "old"));
		expect(stream.push(finish("empty-array", []))?.snapshot?.content).toEqual([]);
	});

	test("keeps block index order and independent message/thread identities", () => {
		const stream = new BailianEventAccumulator();
		stream.push({
			...start("a"),
			thread_id: "thread-a",
			created_at: "2026-10-16T00:00:00Z",
			metadata: { custom: true },
		});
		stream.push({ ...start("b", "reasoning"), thread_id: "thread-b" });
		stream.push(delta("a", "B", 1));
		stream.push(delta("b", "Thinking"));
		stream.push(delta("a", "A", 0));
		expect(stream.push(delta("a", "C", 1))?.content).toBe("ABC");
		const finalA = stream.push(finish("a"))!;
		expect(finalA.snapshot).toMatchObject({
			event_id: "a",
			role: "assistant",
			created_at: "2026-10-16T00:00:00Z",
			metadata: { session_thread_id: "thread-a", custom: true },
		});
		const finalB = stream.push(finish("b"))!;
		expect(finalB.raw_type).toBe("reasoning");
		expect(finalB.content).toBe("Thinking");
		expect(finalB.session_thread_id).toBe("thread-b");
	});

	test("buffers content before message identity and lets a final snapshot supersede it", () => {
		const stream = new BailianEventAccumulator();
		expect(stream.push(delta("a", "early"))).toBeUndefined();
		const initial = stream.push(start("a", "reasoning"))!;
		expect(initial.type).toBe("thinking");
		expect(initial.content).toBe("early");
		stream.push(delta("b", "discard"));
		const final = stream.push({
			...finish("b", [{ type: "text", text: "authoritative" }]),
			type: "message",
			role: "assistant",
		})!;
		expect(final.content).toBe("authoritative");
		expect(final.raw_type).toBe("message");
	});

	test("retains completed reasoning with no content", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("r", "reasoning"));
		const final = stream.push(finish("r"))!;
		expect(final.snapshot?.content).toBeUndefined();
		expect(final.snapshot?.metadata?.event_status).toBe("completed");
	});

	test("reconciles history, suppresses completed replay, and accepts authoritative corrections", () => {
		const stream = new BailianEventAccumulator();
		stream.push({ ...start("m"), metadata: { known: true } });
		stream.push(delta("m", "partial"));
		const raw = { ...finish("m", [{ type: "text", text: "final" }]), type: "message" };
		expect(stream.seed(raw)?.content).toBe("final");
		expect(stream.push(raw)).toBeUndefined();
		expect(stream.seed({ ...raw, content: [{ type: "text", text: "corrected" }] })?.snapshot?.metadata?.known).toBe(
			true,
		);
		expect(stream.push(delta("m", "late"))).toBeUndefined();
	});

	test("reset drops interrupted baselines and waits for a new authoritative identity", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("m"));
		stream.push(delta("m", "old half"));
		stream.resetPartials();
		expect(stream.push(delta("m", "new tail"))).toBeUndefined();
		const restored = stream.seed({
			...finish("m", [{ type: "text", text: "full restored message" }]),
			type: "message",
		});
		expect(restored?.content).toBe("full restored message");
		expect(stream.push(delta("m", "duplicate tail"))).toBeUndefined();
	});

	test("does not present an unbased resumed tail as a completed message", () => {
		const stream = new BailianEventAccumulator();
		stream.resetPartials();
		stream.push(delta("m", "only a tail"));
		expect(() => stream.push({ ...finish("m"), type: "message" })).toThrow("missing an authoritative content snapshot");
		expect(stream.seed({ ...finish("m", [{ type: "text", text: "entire message" }]), type: "message" })?.content).toBe(
			"entire message",
		);
	});

	test("requires explicit history content for interrupted text, but permits contentless reasoning", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("text"));
		stream.push(delta("text", "known half"));
		stream.push(start("reasoning", "reasoning"));
		stream.resetPartials();
		expect(() => stream.seed({ ...finish("text"), type: "message" })).toThrow(
			"missing an authoritative content snapshot",
		);
		expect(stream.seed({ ...finish("reasoning"), type: "reasoning" })?.snapshot?.content).toBeUndefined();
		expect(stream.seed({ ...finish("text", []), type: "message" })?.snapshot?.content).toEqual([]);
	});

	test("a sparse restarted identity cannot turn a resumed tail into a complete message", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("m"));
		stream.push(delta("m", "old first block", 0));
		stream.push(delta("m", "old second block", 1));
		stream.resetPartials();
		expect(stream.push(start("m"))).toBeUndefined();
		expect(stream.push(delta("m", "tail", 1))).toBeUndefined();
		expect(stream.push(delta("m", "complete second block", 1, false))).toBeUndefined();
		expect(() => stream.push(finish("m"))).toThrow("missing an authoritative content snapshot");
		expect(
			stream.push(
				finish("m", [
					{ type: "text", text: "full first" },
					{ type: "text", text: "full second" },
				]),
			)?.content,
		).toBe("full firstfull second");
	});

	test("retains pending IDs across reset so recovery can repair older concurrent messages", () => {
		const stream = new BailianEventAccumulator();
		stream.push(start("older"));
		stream.push(delta("older", "partial"));
		stream.push(delta("orphan", "partial"));
		stream.push(start("reasoning", "reasoning"));
		stream.seed({ ...finish("newer", [{ type: "text", text: "done" }]), type: "message" });
		expect(stream.pendingMessageIds().sort()).toEqual(["older", "orphan", "reasoning"]);
		stream.resetPartials();
		stream.resetPartials();
		expect(stream.pendingMessageIds().sort()).toEqual(["older", "orphan", "reasoning"]);
		stream.seed({ ...finish("older", [{ type: "text", text: "recovered" }]), type: "message" });
		stream.seed({ ...finish("reasoning"), type: "reasoning" });
		expect(stream.pendingMessageIds()).toEqual(["orphan"]);
	});

	test("correlates concurrent tool results by call_id, including artifacts with omitted tool name", () => {
		const stream = new BailianEventAccumulator();
		const call = (id: string, name: string) => ({
			object: "message",
			id,
			type: "tool_call",
			status: "completed",
			content: [{ type: "data", data: { call_id: id, name, arguments: {} } }],
		});
		stream.push(call("call-artifact", "mark_artifacts"));
		stream.push(call("call-search", "search"));
		const output = (id: string, result: unknown) => ({
			object: "message",
			id: `output-${id}`,
			type: "tool_call_output",
			status: "completed",
			content: [{ type: "data", data: { call_id: id, output: result } }],
		});
		expect(stream.push(output("call-search", { answer: 1 }))?.tool_name).toBe("search");
		const artifact = stream.push(
			output("call-artifact", { marked: [{ file_id: "file-1", path: "/out/report" }], failed: [] }),
		)!;
		expect(artifact.tool_name).toBe("mark_artifacts");
		expect(artifact.snapshot?.metadata?.artifacts).toEqual([
			{ file_id: "file-1", path: "/out/report", filename: "report" },
		]);
		expect(stream.push(output("unknown-call", { marked: [{ file_id: "file-2" }] }))?.artifact).toBeUndefined();
	});

	test("reports malformed frames and bounded orphan buffers without payload leakage", () => {
		const stream = new BailianEventAccumulator({ maxEntries: 2 });
		expect(() => stream.push({ ...delta("m", "secret"), index: -1 })).toThrow("invalid index");
		expect(() => stream.push({ ...delta("m", "secret"), msg_id: undefined })).toThrow("missing msg_id");
		stream.push(delta("m", "1"));
		stream.push(delta("m", "2"));
		expect(() => stream.push(delta("m", "secret"))).toThrow("orphan content buffer exceeded");
		stream.clear();
		expect(stream.push(delta("m", "again"))).toBeUndefined();
	});

	test("evicts completed entries rather than active messages and retains unknown no-id events", () => {
		const stream = new BailianEventAccumulator({ maxEntries: 2 });
		stream.seed({ id: "old", type: "message", content: [] });
		stream.push(start("active"));
		stream.push(start("next"));
		expect(stream.push(delta("active", "still tracked"))?.content).toBe("still tracked");
		expect(() => stream.push(start("overflow"))).toThrow("active message buffer exceeded");
		const unknown = stream.push({ type: "future", data: { retained: true } });
		expect(unknown?.snapshot).toEqual({ type: "future", metadata: { data: { retained: true } } });
	});
});

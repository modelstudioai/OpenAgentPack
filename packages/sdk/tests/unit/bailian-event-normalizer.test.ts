import { describe, expect, test } from "bun:test";
import { createBailianSessionEventNormalizer } from "../../src/session-events.ts";

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
});
const finish = (id: string, content?: unknown[]) => ({
	object: "message",
	id,
	status: "completed",
	...(content === undefined ? {} : { content }),
});
const text = (value: string) => [{ type: "text", text: value }];

describe("public browser Bailian normalizer", () => {
	test("maps interleaved incremental frames to independent cumulative snapshots", () => {
		const normalizer = createBailianSessionEventNormalizer({ redact: false, truncate: false });
		expect(normalizer.push(delta("a", "B", 1))).toBeUndefined();
		normalizer.push({ ...start("a"), thread_id: "thread-a" });
		normalizer.push(start("b", "reasoning"));
		const first = normalizer.push(delta("a", "A"))!;
		expect(first.content).toEqual([...text("A"), ...text("B")]);
		expect(normalizer.push(delta("a", "A"))?.content).toEqual([...text("AA"), ...text("B")]);
		expect(normalizer.push(delta("b", "thinking"))).toMatchObject({
			event_id: "b",
			type: "reasoning",
			content: text("thinking"),
		});
		expect(normalizer.push(finish("a", text("final")))).toMatchObject({
			event_id: "a",
			content: text("final"),
			metadata: { event_status: "completed", session_thread_id: "thread-a" },
		});
		expect(first.content).toEqual([...text("A"), ...text("B")]);
		expect(normalizer.push(delta("a", "late"))).toBeUndefined();
		normalizer.push(start("empty"));
		normalizer.push(delta("empty", "old"));
		expect(normalizer.push(finish("empty", []))?.content).toEqual([]);
		expect(normalizer.push({ type: "future", payload: { preserved: true } })).toMatchObject({
			type: "future",
			metadata: { payload: { preserved: true } },
		});
	});

	test("shows unfinished history but never appends a buffered tail or trusts a single replacement block", () => {
		const normalizer = createBailianSessionEventNormalizer();
		const historical = {
			...start("m"),
			thread_id: "thread-1",
			created_at: "2026-10-20T00:00:00Z",
			content: [...text("old first block"), ...text("old second block")],
		};
		expect(normalizer.seed(historical)).toMatchObject({
			event_id: "m",
			role: "assistant",
			content: historical.content,
			metadata: { event_status: "in_progress", session_thread_id: "thread-1" },
		});
		expect(normalizer.push(delta("m", "tail", 1))).toBeUndefined();
		expect(normalizer.push(delta("m", "complete second", 1, false))).toBeUndefined();
		expect(normalizer.push({ ...start("m"), content: text("older buffered snapshot") })).toBeUndefined();
		expect(() => normalizer.push(finish("m"))).toThrow("missing an authoritative content snapshot");
		expect(normalizer.push(finish("m", [...text("full first"), ...text("full second")]))).toMatchObject({
			content: [...text("full first"), ...text("full second")],
			metadata: { event_status: "completed", session_thread_id: "thread-1" },
		});
		expect(normalizer.push(finish("m", text("older completion")))).toBeUndefined();
	});

	test("locks completed history text against older buffered snapshots but allows same-ID state updates", () => {
		const normalizer = createBailianSessionEventNormalizer();
		normalizer.seed({ id: "m", type: "message", content: text("history final") });
		expect(normalizer.push({ ...start("m"), content: text("stale") })).toBeUndefined();
		expect(normalizer.push({ ...finish("m", text("stale completed")), type: "message" })).toBeUndefined();
		expect(normalizer.seed({ ...start("m"), content: text("stale history") })).toBeUndefined();
		const status = {
			...finish("state"),
			type: "session_status",
			content: [{ type: "data", data: { session_status: "running" } }],
		};
		expect(normalizer.seed(status)?.metadata?.status).toBe("running");
		expect(
			normalizer.push({ ...status, content: [{ type: "data", data: { session_status: "idle" } }] })?.metadata?.status,
		).toBe("idle");
	});

	test("preserves unfinished history running and approval identity without falsely completing it", () => {
		const normalizer = createBailianSessionEventNormalizer();
		expect(
			normalizer.seed({
				...start("state", "session_status"),
				content: [
					{ type: "data", data: { session_status: "running", pending_batch_id: "batch", pending_call_ids: ["call"] } },
				],
			}),
		).toMatchObject({
			metadata: {
				event_status: "in_progress",
				status: "running",
				pending_batch_id: "batch",
				pending_call_ids: ["call"],
			},
		});
		expect(
			normalizer.push({ ...finish("state"), content: [{ type: "data", data: { session_status: "idle" } }] })?.metadata,
		).toMatchObject({
			event_status: "completed",
			status: "idle",
		});
		expect(() => normalizer.seed({ ...start(""), content: [] })).toThrow("missing its event ID");
		expect(() => normalizer.seed(delta("state", "invalid history"))).toThrow("history must contain complete events");
	});

	test("correlates history tool calls with live artifacts while retaining unknown content", () => {
		const normalizer = createBailianSessionEventNormalizer({ redact: false, truncate: false });
		normalizer.seed({
			...finish("tool"),
			type: "tool_call",
			content: [{ type: "data", data: { call_id: "c1", name: "mark_artifacts", arguments: { files: ["f1"] } } }],
		});
		const result = normalizer.push({
			...finish("output"),
			type: "tool_call_output",
			content: [
				{
					type: "data",
					data: { call_id: "c1", output: { marked: [{ file_id: "f1", path: "/out/report.html" }], failed: [] } },
				},
				{ type: "future_block", custom: true },
			],
		})!;
		expect(result.metadata).toMatchObject({
			tool_name: "mark_artifacts",
			call_id: "c1",
			artifacts: [{ file_id: "f1", path: "/out/report.html", filename: "report.html" }],
		});
		expect(result.content?.[1]).toEqual({ type: "future_block", custom: true });
	});

	test("keeps sanitizer defaults and opt-in full fidelity on both history and incremental output", () => {
		const raw = { ...finish("secret", text(`token=synthetic-value ${"x".repeat(4100)}`)), type: "message" };
		const defaults = createBailianSessionEventNormalizer().seed(raw)!;
		expect(defaults.metadata).toMatchObject({ redacted: true, truncated: true });
		expect(defaults.metadata?.raw).toBeUndefined();
		expect(defaults.content?.[0]?.text).not.toContain("synthetic-value");
		const complete = createBailianSessionEventNormalizer({ redact: false, truncate: false });
		expect(complete.seed(raw)?.content).toEqual(raw.content);
		complete.push(start("live"));
		expect(complete.push(delta("live", raw.content![0]!.text as string))?.content).toEqual(raw.content);
		const rawOutput = createBailianSessionEventNormalizer({ includeRaw: true }).seed(raw)!;
		expect(rawOutput.metadata?.raw).toBeDefined();
		expect(JSON.stringify(rawOutput.metadata?.raw)).not.toContain("synthetic-value");
	});

	test("bounds retained history and orphan frames, isolates subscriptions and clears recovery state", () => {
		const first = createBailianSessionEventNormalizer({ maxEntries: 2 });
		const second = createBailianSessionEventNormalizer();
		first.seed({ ...finish("m", text("completed")), type: "message" });
		first.seed({ ...start("pending"), content: text("half") });
		expect(() => first.push(start("overflow"))).toThrow("message buffer exceeded");
		second.push(start("m"));
		expect(second.push(delta("m", "independent"))?.content).toEqual(text("independent"));
		first.clear();
		first.push(start("m"));
		expect(first.push(delta("m", "fresh"))?.content).toEqual(text("fresh"));
		first.clear();
		first.push(delta("orphan", "one"));
		first.push(delta("orphan", "two"));
		expect(() => first.push(delta("orphan", "synthetic-secret"))).toThrow("orphan content buffer exceeded its limit.");
		first.clear();
		first.push(start("blocks"));
		first.push(delta("blocks", "a", 0));
		first.push(delta("blocks", "b", 1));
		expect(() => first.push(delta("blocks", "c", 2))).toThrow("content block buffer exceeded");
		expect(() => createBailianSessionEventNormalizer({ maxEntries: 0 })).toThrow(RangeError);
	});

	test("bundles the public subpath for browsers without SDK Node modules", async () => {
		const result = await Bun.build({
			entrypoints: [new URL("../../src/session-events.ts", import.meta.url).pathname],
			target: "browser",
			minify: false,
		});
		expect(result.success).toBe(true);
		const bundled = await result.outputs[0]!.text();
		expect(bundled).toContain("createBailianSessionEventNormalizer");
		expect(bundled).not.toMatch(/from ["'](?:node:|fs|path|crypto|http|https)["']/);
		expect(bundled).not.toContain("process.env");
	});
});

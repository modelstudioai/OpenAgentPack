import { describe, expect, test } from "bun:test";
import { toSessionEvent } from "../../src/internal/providers/bailian/event-mapper.ts";
import { BailianEventProtocolError } from "../../src/internal/providers/bailian/snapshot-mapper.ts";
import { SessionEventSchema } from "../../src/internal/types/dto.ts";

const snapshot = (raw: Record<string, unknown>) => toSessionEvent(raw, { event_format: "snapshot" });

describe("Bailian structured event mapping", () => {
	test("legacy callers retain their exact output while snapshot mode preserves complete message identity", () => {
		const raw = {
			object: "message",
			id: "msg-1",
			type: "reasoning",
			status: "completed",
			role: "assistant",
			created_at: "2026-10-16T00:00:00Z",
			thread_id: "thread-1",
			content: [{ type: "text", text: "Thinking" }],
		};
		expect(toSessionEvent(raw)).toEqual({
			type: "thinking",
			raw_type: "reasoning",
			id: "msg-1",
			role: "assistant",
			raw,
		});
		const event = snapshot(raw);
		expect(event.content).toBe("Thinking");
		expect(event.session_thread_id).toBe("thread-1");
		expect(event.snapshot).toEqual({
			event_id: "msg-1",
			type: "reasoning",
			role: "assistant",
			created_at: raw.created_at,
			content: raw.content,
			metadata: { event_status: "completed", thread_id: "thread-1", session_thread_id: "thread-1" },
		});
		expect(SessionEventSchema.safeParse(event.snapshot).success).toBe(true);
	});

	test("keeps unknown multimodal blocks and event-specific data without fabricating content", () => {
		const raw = {
			type: "future_evaluation",
			score: 0.7,
			metadata: { custom: { valid: true } },
			content: [
				{ type: "image", image_url: { url: "https://example.test/image" } },
				{ type: "future", data: { score: 1 } },
			],
		};
		const event = snapshot(raw);
		expect(event.type).toBe("unknown");
		expect(event.snapshot?.type).toBe("future_evaluation");
		expect(event.snapshot?.content).toEqual(raw.content);
		expect(event.snapshot?.metadata).toEqual({ custom: { valid: true }, score: 0.7 });
		expect(snapshot({ type: "reasoning", status: "in_progress" }).snapshot).toEqual({
			type: "reasoning",
			metadata: { event_status: "in_progress" },
		});
	});

	test("separates message lifecycle from session status and preserves approval variants", () => {
		const stopReason = { type: "requires_action", event_ids: ["event-1"], call_ids: ["call-1"] };
		const data = {
			session_status: "idle",
			stop_reason: stopReason,
			pending_batch_id: "batch-1",
			pending_call_ids: ["call-1"],
		};
		const event = snapshot({
			object: "message",
			type: "session_status",
			status: "completed",
			content: [{ type: "data", data }],
		});
		expect(event.status).toBe("idle");
		expect(event.stop_reason).toBe("requires_action");
		expect(event.snapshot?.metadata).toEqual({
			event_status: "completed",
			status: "idle",
			stop_reason: stopReason,
			pending_batch_id: "batch-1",
			pending_call_ids: ["call-1"],
		});
		expect(event.snapshot?.content?.[0]?.data).toEqual(data);
	});

	test("does not mistake a completed status-message lifecycle for a completed session", () => {
		const raw = { object: "message", type: "session_status", status: "completed" };
		expect(toSessionEvent(raw).status).toBe("completed");
		const mapped = snapshot(raw);
		expect(mapped.status).toBeUndefined();
		expect(mapped.snapshot?.metadata).toEqual({ event_status: "completed" });
		const explicit = snapshot({ ...raw, status: "in_progress", session_status: "running" });
		expect(explicit.status).toBe("running");
		expect(explicit.snapshot?.metadata).toMatchObject({ event_status: "in_progress", status: "running" });
		const metadataStatus = snapshot({ ...raw, metadata: { status: "idle" } });
		expect(metadataStatus.status).toBe("idle");
		expect(metadataStatus.snapshot?.metadata).toEqual({ event_status: "completed", status: "idle" });
		const legacyEnvelope = snapshot({ type: "session_status", status: "idle" });
		expect(legacyEnvelope.status).toBe("idle");
		expect(legacyEnvelope.snapshot?.metadata).toEqual({ status: "idle" });
	});

	test("keeps structured arguments, failures and MCP metadata in all tool variants", () => {
		for (const type of ["tool_call", "function_call", "mcp_call"]) {
			const data = {
				name: "search",
				call_id: "call-1",
				arguments: { query: "topic" },
				server_label: "docs",
				evaluated_permission: "ask",
			};
			const event = snapshot({
				type,
				content: [
					{ type: "text", text: "Calling" },
					{ type: "data", data },
				],
			});
			expect(event.tool_name).toBe("search");
			expect(event.tool_input).toBe('{"query":"topic"}');
			expect(event.snapshot?.metadata).toMatchObject({
				tool_name: "search",
				tool_input: { query: "topic" },
				call_id: "call-1",
				server_label: "docs",
				evaluated_permission: "ask",
			});
			const output = snapshot({
				type: `${type}_output`,
				is_error: true,
				content: [{ type: "data", data: { call_id: "call-1", output: { reason: "denied" } } }],
			});
			expect(output.snapshot?.is_error).toBe(true);
			expect(output.snapshot?.content?.[0]?.data).toEqual({ call_id: "call-1", output: { reason: "denied" } });
		}
	});

	test("retains nested errors, root aliases, and routing fields", () => {
		const error = snapshot({
			type: "error",
			error: { code: "denied", message: "Access denied", detail: { retry: false } },
		});
		expect(error.snapshot).toMatchObject({
			code: "denied",
			message: "Access denied",
			metadata: { error: { code: "denied", message: "Access denied", detail: { retry: false } } },
		});
		expect(error.content).toBe("Access denied");
		expect(error.snapshot?.is_error).toBe(true);
		const routed = snapshot({
			type: "thread_message_sent",
			from_thread_id: "parent",
			to_thread_id: "child",
			content: [{ type: "data", data: { session_thread_id: "child" } }],
		});
		expect(routed.snapshot?.role).toBe("user");
		expect(routed.snapshot?.metadata).toMatchObject({
			from_thread_id: "parent",
			to_thread_id: "child",
			session_thread_id: "child",
		});
	});

	test("derives artifact descriptors only from identified successful tool results", () => {
		const output = {
			marked: [
				{ file_id: " file-1 ", path: "/out/report.pdf", description: "Report" },
				{ file_id: "" },
				{ file_id: "file-2", filename: "data.csv" },
			],
			failed: [{ path: "/out/missing" }],
		};
		const raw = {
			type: "tool_call_output",
			content: [{ type: "data", data: { name: "mark_artifacts", output: JSON.stringify(output) } }],
		};
		const event = snapshot(raw);
		expect(event.snapshot?.metadata?.artifacts).toEqual([
			{ file_id: "file-1", path: "/out/report.pdf", filename: "report.pdf", description: "Report" },
			{ file_id: "file-2", filename: "data.csv" },
		]);
		expect(event.artifact).toEqual({ file_id: "file-1", filename: "report.pdf" });
		expect(event.snapshot?.content).toEqual(raw.content);
		expect(snapshot({ ...raw, is_error: true }).snapshot?.metadata?.artifacts).toBeUndefined();
		expect(
			snapshot({ ...raw, content: [{ type: "data", data: { output } }] }).snapshot?.metadata?.artifacts,
		).toBeUndefined();
	});

	test("clones structured output and rejects frames that require stream context", () => {
		const raw = { type: "message", content: [{ type: "image", data: { nested: [1] } }], metadata: { nested: [2] } };
		const event = snapshot(raw);
		(event.snapshot!.content![0]!.data as { nested: number[] }).nested.push(3);
		(event.snapshot!.metadata!.nested as number[]).push(4);
		expect(raw.content[0]!.data.nested).toEqual([1]);
		expect(raw.metadata.nested).toEqual([2]);
		expect(() => snapshot({ object: "content", type: "text", text: "secret", msg_id: "msg-1" })).toThrow(
			BailianEventProtocolError,
		);
		expect(() => snapshot({ status: "completed" })).toThrow("missing its type");
	});
});

import { describe, expect, test } from "bun:test";
import {
	mapSendMessage as bailianMapSend,
	toSessionEvent as bailianToEvent,
} from "../../src/internal/providers/bailian/mapper.ts";
import {
	mapSendMessage as claudeMapSend,
	toSessionEvent as claudeToEvent,
} from "../../src/internal/providers/claude/mapper.ts";
import {
	mapSendMessage as qoderMapSend,
	toSessionEvent as qoderToEvent,
} from "../../src/internal/providers/qoder/mapper.ts";

describe("Bailian mapper", () => {
	test("mapSendMessage", () => {
		const result = bailianMapSend("hello") as Record<string, unknown>;
		const input = (result.input as unknown[])[0] as Record<string, unknown>;
		expect(input.role).toBe("user");
		expect(input.type).toBe("message");
		const content = (input.content as Record<string, unknown>[])[0]!;
		expect(content.type).toBe("text");
		expect(content.text).toBe("hello");
	});

	test("toSessionEvent maps message", () => {
		const event = bailianToEvent({
			object: "message",
			status: "completed",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		});
		expect(event.type).toBe("message");
		expect(event.raw_type).toBe("message");
		expect(event.role).toBe("assistant");
		expect(event.content).toBe("hi");
	});

	test("toSessionEvent retains user role for echoed messages", () => {
		const event = bailianToEvent({
			object: "message",
			status: "completed",
			type: "message",
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
		expect(event.role).toBe("user");
		expect(event.content).toBe("hello");
	});

	test("toSessionEvent maps tool_call to tool_use", () => {
		const event = bailianToEvent({
			type: "tool_call",
			content: [{ data: { name: "bash", arguments: '{"cmd":"ls"}' } }],
		});
		expect(event.type).toBe("tool_use");
		expect(event.tool_name).toBe("bash");
		expect(event.tool_input).toBe('{"cmd":"ls"}');
	});

	test("toSessionEvent maps tool_call_output to tool_result", () => {
		const event = bailianToEvent({
			object: "message",
			status: "completed",
			type: "tool_call_output",
			role: "tool",
			content: [
				{
					type: "data",
					data: { name: "bash", call_id: "call_123", output: "output text" },
				},
			],
		});
		expect(event.type).toBe("tool_result");
		expect(event.role).toBe("tool");
		expect(event.tool_name).toBe("bash");
		expect(event.content).toBe("output text");
	});

	test("toSessionEvent maps session_status to status", () => {
		const idle = bailianToEvent({
			object: "message",
			status: "completed",
			type: "session_status",
			content: [
				{
					type: "data",
					data: { session_status: "idle", stop_reason: { type: "end_turn" } },
				},
			],
		});
		expect(idle.type).toBe("status");
		expect(idle.status).toBe("idle");
		expect(idle.stop_reason).toBe("end_turn");

		const running = bailianToEvent({
			object: "message",
			status: "completed",
			type: "session_status",
			content: [{ type: "data", data: { session_status: "running" } }],
		});
		expect(running.type).toBe("status");
		expect(running.status).toBe("running");
	});

	test("toSessionEvent maps reasoning, error, and unknown events", () => {
		expect(bailianToEvent({ type: "reasoning" }).type).toBe("thinking");
		const error = bailianToEvent({ type: "error", message: "something broke" });
		expect(error.type).toBe("error");
		expect(error.content).toBe("something broke");
		const unknown = bailianToEvent({ type: "some_future_type" });
		expect(unknown.type).toBe("unknown");
		expect(unknown.raw_type).toBe("some_future_type");
	});

	test("toSessionEvent maps function_call / mcp_call variants like tool_call", () => {
		const fn = bailianToEvent({ type: "function_call", content: [{ data: { name: "search", arguments: "{}" } }] });
		expect(fn.type).toBe("tool_use");
		expect(fn.tool_name).toBe("search");
		const mcp = bailianToEvent({ type: "mcp_call", content: [{ data: { name: "fetch", arguments: "{}" } }] });
		expect(mcp.type).toBe("tool_use");
		expect(mcp.tool_name).toBe("fetch");
		const fnOut = bailianToEvent({
			type: "function_call_output",
			content: [{ type: "data", data: { name: "search", output: "done" } }],
		});
		expect(fnOut.type).toBe("tool_result");
		expect(fnOut.tool_name).toBe("search");
		expect(fnOut.content).toBe("done");
		const mcpOut = bailianToEvent({
			type: "mcp_call_output",
			content: [{ type: "data", data: { name: "fetch", output: "ok" } }],
		});
		expect(mcpOut.type).toBe("tool_result");
		expect(mcpOut.tool_name).toBe("fetch");
		expect(mcpOut.content).toBe("ok");
		expect(bailianToEvent({ type: "thread_message_sent", content: [{ type: "text", text: "hi" }] }).type).toBe(
			"message",
		);
		expect(bailianToEvent({ type: "thread_message_received", content: [{ type: "text", text: "yo" }] }).type).toBe(
			"message",
		);
		// thread_* variants may omit role; derive the actor from the event type.
		expect(bailianToEvent({ type: "thread_message_sent", content: [{ type: "text", text: "hi" }] }).role).toBe("user");
		expect(bailianToEvent({ type: "thread_message_received", content: [{ type: "text", text: "yo" }] }).role).toBe(
			"assistant",
		);
	});
});

describe("Claude mapper", () => {
	test("mapSendMessage", () => {
		const result = claudeMapSend("review code") as Record<string, unknown>;
		const events = result.events as Record<string, unknown>[];
		const message = events[0]!;
		expect(message.type).toBe("user.message");
		const content = (message.content as Record<string, unknown>[])[0]!;
		expect(content.type).toBe("text");
		expect(content.text).toBe("review code");
	});

	test("toSessionEvent maps common event types", () => {
		const agentMsg = claudeToEvent({ type: "agent.message", content: [{ type: "text", text: "hello" }] });
		expect(agentMsg.type).toBe("message");
		// Real agent.message carries no role; derive "assistant" from the event type.
		expect(agentMsg.role).toBe("assistant");
		const userMsg = claudeToEvent({ type: "user.message", content: [{ type: "text", text: "hi" }] });
		expect(userMsg.type).toBe("message");
		expect(userMsg.role).toBe("user");
		expect(userMsg.content).toBe("hi");
		const toolUse = claudeToEvent({ type: "agent.tool_use", name: "Read", input: { path: "/tmp" } });
		expect(toolUse.type).toBe("tool_use");
		expect(toolUse.tool_name).toBe("Read");
		expect(toolUse.tool_input).toBe('{"path":"/tmp"}');
		expect(claudeToEvent({ type: "agent.tool_result", content: [{ type: "text", text: "file contents" }] }).type).toBe(
			"tool_result",
		);
		expect(claudeToEvent({ type: "session.status_idle", stop_reason: "end_turn" }).type).toBe("status");
		expect(claudeToEvent({ type: "session.status_running" }).status).toBe("running");
		expect(claudeToEvent({ type: "agent.thinking" }).type).toBe("thinking");
		const error = claudeToEvent({ type: "session.error", error: "rate limit exceeded" });
		expect(error.type).toBe("error");
		expect(error.content).toBe("rate limit exceeded");
	});
});

describe("Qoder mapper", () => {
	test("mapSendMessage", () => {
		const result = qoderMapSend("fix bug") as Record<string, unknown>;
		const events = result.events as Record<string, unknown>[];
		expect(events[0]!.type).toBe("user.message");
		expect(events[0]!.content).toEqual([{ type: "text", text: "fix bug" }]);
	});

	test("toSessionEvent maps common event types", () => {
		const agentMsg = qoderToEvent({ type: "agent.message", content: [{ type: "text", text: "done" }] });
		expect(agentMsg.type).toBe("message");
		// Real agent.message carries no role; derive "assistant" from the event type.
		expect(agentMsg.role).toBe("assistant");
		const toolUse = qoderToEvent({ type: "agent.tool_use", tool_name: "Bash", tool_input: "ls -la" });
		expect(toolUse.type).toBe("tool_use");
		expect(toolUse.tool_name).toBe("Bash");
		expect(toolUse.tool_input).toBe("ls -la");
		expect(qoderToEvent({ type: "agent.tool_result", content: "result text" }).type).toBe("tool_result");
		expect(qoderToEvent({ type: "session.status_idle", stop_reason: "end_turn" }).status).toBe("idle");
		expect(qoderToEvent({ type: "session.status_running" }).status).toBe("running");
		expect(qoderToEvent({ type: "agent.thinking" }).type).toBe("thinking");
		const error = qoderToEvent({ type: "session.error", error: "timeout" });
		expect(error.type).toBe("error");
		expect(error.content).toBe("timeout");
		const unknown = qoderToEvent({ type: "agent.artifact_delivered" });
		expect(unknown.type).toBe("unknown");
		expect(unknown.raw_type).toBe("agent.artifact_delivered");
	});

	test("toSessionEvent surfaces artifact descriptor on artifact_delivered", () => {
		const event = qoderToEvent({
			type: "agent.artifact_delivered",
			file_id: "file_123",
			original_filename: "report.html",
			content_type: "text/html",
			size: 45771,
		});
		// stays "unknown" (hidden from timeline) but carries the structured artifact slot
		expect(event.type).toBe("unknown");
		expect(event.artifact).toEqual({
			file_id: "file_123",
			filename: "report.html",
			content_type: "text/html",
			size: 45771,
		});
	});

	test("toSessionEvent omits artifact when file_id missing", () => {
		expect(qoderToEvent({ type: "agent.artifact_delivered" }).artifact).toBeUndefined();
	});
});

describe("Bailian event edge cases", () => {
	test("content normalization", () => {
		expect(
			bailianToEvent({
				object: "message",
				type: "message",
				role: "assistant",
				content: [
					{ type: "text", text: "Hello " },
					{ type: "text", text: "world" },
				],
			}).content,
		).toBe("Hello world");
		expect(bailianToEvent({ type: "message", role: "assistant", content: [] }).content).toBe("");
		expect(bailianToEvent({ type: "message", role: "assistant" }).content).toBe("");
	});

	test("missing fields", () => {
		const tool = bailianToEvent({ type: "tool_call", content: [] });
		expect(tool.type).toBe("tool_use");
		expect(tool.tool_name).toBe("");
		const unknown = bailianToEvent({});
		expect(unknown.type).toBe("unknown");
		expect(unknown.raw_type).toBe("");
	});
});

describe("Claude event edge cases", () => {
	test("content and tool normalization", () => {
		expect(
			claudeToEvent({
				type: "agent.message",
				content: [
					{ type: "text", text: "Part 1 " },
					{ type: "text", text: "Part 2" },
				],
			}).content,
		).toBe("Part 1 Part 2");
		expect(claudeToEvent({ type: "agent.message", content: [] }).content).toBe("");
		expect(claudeToEvent({ type: "agent.message", content: "plain string" }).content).toBe("plain string");
		expect(claudeToEvent({ type: "agent.tool_use", name: "Bash", input: { command: "ls" } }).tool_input).toBe(
			'{"command":"ls"}',
		);
		expect(claudeToEvent({ type: "agent.tool_use", name: "Read" }).tool_input).toBe("{}");
		expect(claudeToEvent({ type: "session.error" }).content).toBe("");
	});
});

describe("Qoder event edge cases", () => {
	test("content and tool normalization", () => {
		expect(
			qoderToEvent({
				type: "agent.message",
				content: [
					{ type: "text", text: "A" },
					{ type: "text", text: "B" },
					{ type: "text", text: "C" },
				],
			}).content,
		).toBe("ABC");
		expect(qoderToEvent({ type: "agent.tool_result", content: "raw output" }).content).toBe("raw output");
		expect(
			qoderToEvent({ type: "agent.tool_use", tool_name: "Bash", name: "fallback", tool_input: "ls" }).tool_name,
		).toBe("Bash");
		const fallback = qoderToEvent({ type: "agent.tool_use", name: "Read", input: "/tmp/file" });
		expect(fallback.tool_name).toBe("Read");
		expect(fallback.tool_input).toBe("/tmp/file");
	});
});

describe("session adapter correctness regressions", () => {
	test("Claude mapSendMessage wraps events in a JSON object", () => {
		const result = claudeMapSend("hello") as Record<string, unknown>;
		expect(Array.isArray(result)).toBe(false);
		const events = result.events as Record<string, unknown>[];
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("user.message");
	});

	test("status and error normalization", () => {
		expect(claudeToEvent({ type: "session.status_idle", stop_reason: { type: "end_turn" } }).stop_reason).toBe(
			"end_turn",
		);
		expect(qoderToEvent({ type: "session.status_idle", stop_reason: { type: "end_turn" } }).stop_reason).toBe(
			"end_turn",
		);
		expect(claudeToEvent({ type: "session.error", error: { message: "boom", type: "internal_error" } }).content).toBe(
			"boom",
		);
		expect(qoderToEvent({ type: "session.error", error: { message: "boom", type: "internal_error" } }).content).toBe(
			"boom",
		);
	});

	test("provider-specific event variants", () => {
		const qoderEcho = qoderToEvent({
			type: "user.message",
			content: [{ type: "text", text: "ping" }],
		});
		expect(qoderEcho.type).toBe("message");
		// Real user.message carries no role; derive "user" from the event type.
		expect(qoderEcho.role).toBe("user");
		expect(qoderEcho.content).toBe("ping");
		expect(qoderToEvent({ type: "session.thread_status_idle" }).type).toBe("status");
		const terminated = claudeToEvent({ type: "session.status_terminated" });
		expect(terminated.type).toBe("status");
		expect(terminated.status).toBe("terminated");
		const use = claudeToEvent({ type: "agent.mcp_tool_use", name: "Search", input: { q: "x" } });
		expect(use.type).toBe("tool_use");
		expect(use.tool_name).toBe("Search");
		const result = claudeToEvent({ type: "agent.mcp_tool_result", content: [{ type: "text", text: "ok" }] });
		expect(result.type).toBe("tool_result");
		expect(result.content).toBe("ok");
	});
});

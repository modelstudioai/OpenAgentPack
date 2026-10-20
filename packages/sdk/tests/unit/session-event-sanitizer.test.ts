import { expect, test } from "bun:test";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";
import {
	type SessionEventSanitizerOptions,
	sanitizeSessionEvent,
	sanitizeSessionEvents,
} from "../../src/session-events.ts";

test("surfaces the artifact descriptor onto metadata.artifact", () => {
	const event: ProviderSessionEvent = {
		type: "unknown",
		raw_type: "agent.artifact_delivered",
		raw: {},
		artifact: { file_id: "file_123", filename: "report.html", content_type: "text/html", size: 45771 },
	};
	const result = sanitizeSessionEvent(event);
	expect(result.metadata?.artifact).toEqual({
		file_id: "file_123",
		filename: "report.html",
		content_type: "text/html",
		size: 45771,
	});
	// artifact_delivered stays "unknown", so no display_bucket is emitted
	expect(result.metadata?.display_bucket).toBeUndefined();
});

test("omits metadata.artifact when the event carries none", () => {
	const event: ProviderSessionEvent = {
		type: "message",
		raw_type: "agent.message",
		raw: {},
		role: "assistant",
		content: "hello",
	};
	const result = sanitizeSessionEvent(event);
	expect(result.metadata?.artifact).toBeUndefined();
});

const sensitiveEvent: ProviderSessionEvent = {
	type: "tool_use",
	raw_type: "tool_call",
	tool_name: "example_tool",
	tool_input: "api_key=synthetic-input",
	raw: { detail: "token=synthetic-raw" },
};

const enabledPolicies: { label: string; options?: SessionEventSanitizerOptions }[] = [
	{ label: "omitted options" },
	{ label: "empty options", options: {} },
	{ label: "explicit true", options: { redact: true } },
];

for (const { label, options } of enabledPolicies) {
	test(`redacts event text and its tool input metadata with ${label}`, () => {
		const result = sanitizeSessionEvent(sensitiveEvent, options);
		expect(result.content).toEqual([{ type: "text", text: "api_key: [redacted]" }]);
		expect(result.metadata?.tool_input).toBe("api_key: [redacted]");
		expect(result.metadata?.redacted).toBe(true);
		expect(result.metadata?.raw).toBeUndefined();
	});
}

test("reports redaction when only the tool input metadata changes", () => {
	const result = sanitizeSessionEvent({ ...sensitiveEvent, content: "ordinary text" });
	expect(result.content).toEqual([{ type: "text", text: "ordinary text" }]);
	expect(result.metadata?.tool_input).toBe("api_key: [redacted]");
	expect(result.metadata?.redacted).toBe(true);
});

test("disabling redaction preserves tool text and metadata without opting into raw", () => {
	const result = sanitizeSessionEvent(sensitiveEvent, { redact: false });
	expect(result.content).toEqual([{ type: "text", text: sensitiveEvent.tool_input }]);
	expect(result.metadata?.tool_input).toBe(sensitiveEvent.tool_input);
	expect(result.metadata?.redacted).toBeUndefined();
	expect(result.metadata?.raw).toBeUndefined();
});

test("optional raw follows the redaction policy without mutating the provider event", () => {
	const before = structuredClone(sensitiveEvent);
	const enabled = sanitizeSessionEvent(sensitiveEvent, { includeRaw: true });
	const disabled = sanitizeSessionEvent(sensitiveEvent, { includeRaw: true, redact: false });
	expect(enabled.metadata?.raw).toEqual({ detail: "token: [redacted]" });
	expect(disabled.metadata?.raw).toEqual(sensitiveEvent.raw);
	expect(disabled.metadata?.redacted).toBeUndefined();
	expect(sensitiveEvent).toEqual(before);
});

test("batch redaction is local to each call and also controls error messages", () => {
	const error: ProviderSessionEvent = {
		type: "error",
		raw_type: "error",
		content: "token=synthetic-error",
		raw: {},
	};
	const [tool, failure] = sanitizeSessionEvents([sensitiveEvent, error], { redact: false });
	expect(tool?.metadata?.tool_input).toBe(sensitiveEvent.tool_input);
	expect(failure?.content).toEqual([{ type: "text", text: error.content }]);
	expect(failure?.message).toBe(error.content);
	expect(failure?.is_error).toBe(true);
	expect(failure?.metadata?.redacted).toBeUndefined();
	const [defaultFailure] = sanitizeSessionEvents([error]);
	expect(defaultFailure?.message).toBe("token: [redacted]");
	expect(defaultFailure?.metadata?.redacted).toBe(true);
});

test("disabling redaction keeps the existing truncation policy", () => {
	const content = `api_key=synthetic-long ${"x".repeat(4100)}`;
	const result = sanitizeSessionEvent({ type: "message", raw_type: "message", content, raw: {} }, { redact: false });
	expect(result.content).toEqual([
		{ type: "text", text: `${content.slice(0, 4000)}\n...[truncated ${content.length - 4000} chars]` },
	]);
	expect(result.metadata?.truncated).toBe(true);
	expect(result.metadata?.redacted).toBeUndefined();
});

const longContentCases: { label: string; type: ProviderSessionEvent["type"]; content: string; limit: number }[] = [
	{ label: "message", type: "message", content: "x".repeat(4100), limit: 4000 },
	{ label: "tool", type: "tool_result", content: "x".repeat(8100), limit: 8000 },
	{ label: "document", type: "message", content: `\`\`\`mermaid\n${"x".repeat(32100)}`, limit: 32000 },
];

for (const { label, type, content, limit } of longContentCases) {
	test(`keeps the default ${label} limit and allows complete content explicitly`, () => {
		const event: ProviderSessionEvent = { type, raw_type: type, content, raw: {} };
		const original = sanitizeSessionEvent(event);
		expect(original.content).toEqual([
			{ type: "text", text: `${content.slice(0, limit)}\n...[truncated ${content.length - limit} chars]` },
		]);
		expect(original.metadata?.truncated).toBe(true);
		expect(sanitizeSessionEvent(event, { redact: true, truncate: true })).toEqual(original);
		const full = sanitizeSessionEvent(event, { redact: false, truncate: false });
		expect(full.content).toEqual([{ type: "text", text: content }]);
		expect(full.metadata?.truncated).toBeUndefined();
		expect(full.metadata?.redacted).toBeUndefined();
	});
}

test("disabling truncation keeps redaction enabled by default", () => {
	const content = `api_key=synthetic-long ${"x".repeat(4100)}`;
	const result = sanitizeSessionEvent({ type: "message", raw_type: "message", content, raw: {} }, { truncate: false });
	expect(result.content).toEqual([{ type: "text", text: `api_key: [redacted] ${"x".repeat(4100)}` }]);
	expect(result.metadata?.redacted).toBe(true);
	expect(result.metadata?.truncated).toBeUndefined();
});

test("batch callers can disable both policies for error text and optional raw", () => {
	const content = `token=synthetic-error ${"x".repeat(4100)}`;
	const raw = { detail: `token=synthetic-raw ${"x".repeat(16100)}` };
	const event: ProviderSessionEvent = { type: "error", raw_type: "error", content, raw };
	const before = structuredClone(event);
	const original = sanitizeSessionEvent(event, { includeRaw: true });
	expect(original.metadata?.truncated).toBe(true);
	expect(original.metadata?.redacted).toBe(true);
	expect(String(original.metadata?.raw)).not.toContain("synthetic-raw");
	expect(String(original.metadata?.raw)).toContain("...[truncated ");
	const [full] = sanitizeSessionEvents([event], { redact: false, truncate: false, includeRaw: true });
	expect(full?.content).toEqual([{ type: "text", text: content }]);
	expect(full?.message).toBe(content);
	expect(full?.metadata?.raw).toEqual(raw);
	expect(full?.metadata?.truncated).toBeUndefined();
	expect(full?.metadata?.redacted).toBeUndefined();
	expect(sanitizeSessionEvent(event, { redact: false, truncate: false }).metadata?.raw).toBeUndefined();
	expect(sanitizeSessionEvent(event, { includeRaw: true })).toEqual(original);
	expect(event).toEqual(before);
});

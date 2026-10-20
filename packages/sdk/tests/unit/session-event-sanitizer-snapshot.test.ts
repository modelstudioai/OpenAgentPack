import { expect, test } from "bun:test";
import type { SessionEvent } from "../../src/internal/types/dto.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";
import { sanitizeSessionEvent, toBailianSessionEvent } from "../../src/session-events.ts";

function provider(snapshot: SessionEvent, raw: Record<string, unknown> = {}): ProviderSessionEvent {
	return { type: "message", raw_type: "message", content: "obsolete fallback", snapshot, raw };
}

const longText = `token=synthetic-text ${"x".repeat(4100)}`;
const snapshot: SessionEvent = {
	event_id: "msg-1",
	type: "message",
	role: "assistant",
	created_at: "2026-10-16T01:00:00Z",
	content: [
		{ type: "text", text: longText },
		{
			type: "custom",
			index: 1,
			data: { headers: { api_key: "synthetic-key" }, entries: [false, 2, null, { text: "ordinary" }] },
		},
	],
	metadata: {
		event_status: "in_progress",
		session_thread_id: "thread-1",
		stop_reason: { type: "requires_action", call_ids: ["call-1"] },
		artifacts: [{ file_id: "file-1", filename: "report.html" }],
	},
};

for (const redact of [true, false]) {
	for (const truncate of [true, false]) {
		test(`tool and unknown fields cannot impersonate protocol identities: redact=${redact}, truncate=${truncate}`, () => {
			const secret = "api_key=synthetic-code";
			const code = `${secret} ${"x".repeat(17000)}`;
			const payload = {
				code,
				id: secret,
				type: secret,
				status: secret,
				custom_ids: [secret],
				nested: { event_id: secret, code: { id: secret } },
			};
			const raw = {
				object: "message",
				id: "call-event-1",
				type: "tool_call",
				status: "completed",
				content: [{ type: "data", data: { call_id: "call-1", arguments: payload, output: payload, ...payload } }],
				metadata: { custom: payload },
			};
			const event = toBailianSessionEvent(raw, { event_format: "snapshot" });
			const before = structuredClone(event);
			const expected = (limit: number) => {
				const text = redact ? code.replace(secret, "api_key: [redacted]") : code;
				const leaf = redact ? "api_key: [redacted]" : secret;
				return {
					code: truncate ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text,
					id: leaf,
					type: leaf,
					status: leaf,
					custom_ids: [leaf],
					nested: { event_id: leaf, code: { id: leaf } },
				};
			};
			const result = sanitizeSessionEvent(event, { redact, truncate, includeRaw: true });
			expect(result.content?.[0]?.data).toEqual({
				call_id: "call-1",
				arguments: expected(8000),
				output: expected(8000),
				...expected(8000),
			});
			expect(result.metadata?.tool_input).toEqual(expected(8000));
			expect(result.metadata?.custom).toEqual(expected(8000));
			expect(result.metadata?.raw).toEqual({
				...raw,
				content: [
					{
						type: "data",
						data: {
							call_id: "call-1",
							arguments: expected(16000),
							output: expected(16000),
							...expected(16000),
						},
					},
				],
				metadata: { custom: expected(16000) },
			});
			expect(result.metadata?.redacted).toBe(redact || undefined);
			expect(result.metadata?.truncated).toBe(truncate || undefined);
			expect(event).toEqual(before);
			if (redact && truncate) expect(result).toEqual(sanitizeSessionEvent(event, { includeRaw: true }));
		});
	}
}

for (const redact of [true, false]) {
	for (const truncate of [true, false]) {
		test(`snapshot policies are independent: redact=${redact}, truncate=${truncate}`, () => {
			const input = provider(structuredClone(snapshot));
			const before = structuredClone(input);
			const result = sanitizeSessionEvent(input, { redact, truncate });
			const expectedText = redact ? longText.replace("token=synthetic-text", "token: [redacted]") : longText;
			expect(result.content?.[0]?.text).toBe(
				truncate ? `${expectedText.slice(0, 4000)}\n...[truncated ${expectedText.length - 4000} chars]` : expectedText,
			);
			expect(result.content?.[1]).toEqual({
				type: "custom",
				index: 1,
				data: {
					headers: { api_key: redact ? "[redacted]" : "synthetic-key" },
					entries: [false, 2, null, { text: "ordinary" }],
				},
			});
			expect(result.event_id).toBe(snapshot.event_id);
			expect(result.created_at).toBe(snapshot.created_at);
			expect(result.metadata).toEqual({
				...snapshot.metadata,
				...(redact ? { redacted: true } : {}),
				...(truncate ? { truncated: true } : {}),
			});
			expect(input).toEqual(before);
			expect(result.content).not.toBe(input.snapshot?.content);
			expect(result.content?.[1]?.data).not.toBe(input.snapshot?.content?.[1]?.data);
			expect(result.metadata?.artifacts).not.toBe(input.snapshot?.metadata?.artifacts);
		});
	}
}

test("snapshot defaults keep both policies enabled and empty content is authoritative", () => {
	expect(sanitizeSessionEvent(provider(snapshot))).toEqual(
		sanitizeSessionEvent(provider(snapshot), { redact: true, truncate: true }),
	);
	const event = provider({
		event_id: "msg-empty",
		type: "message",
		content: [],
		metadata: { event_status: "completed" },
	});
	expect(sanitizeSessionEvent(event)).toEqual(event.snapshot);
	expect(sanitizeSessionEvent(provider({ type: "reasoning" }))).toEqual({ type: "reasoning" });
});

test("raw is independently opt-in and uses the actual triggering frame", () => {
	const raw = { object: "content", msg_id: "msg-1", delta: true, text: "part", data: { token: "synthetic-raw" } };
	const event = provider(
		{
			type: "message",
			content: [{ type: "text", text: "full content" }],
			metadata: { raw: { outdated: true }, redacted: true, truncated: true },
		},
		raw,
	);
	expect(sanitizeSessionEvent(event, { redact: false, truncate: false }).metadata).toEqual({});
	expect(sanitizeSessionEvent(event, { includeRaw: true }).metadata).toEqual({
		raw: { ...raw, data: { token: "[redacted]" } },
		redacted: true,
	});
	const complete = sanitizeSessionEvent(event, { includeRaw: true, redact: false, truncate: false });
	expect(complete.metadata).toEqual({ raw });
	expect(complete.metadata?.raw).not.toBe(raw);
	expect(raw.data.token).toBe("synthetic-raw");
});

test("structured secret containers retain their shape and non-secret policy fields remain intact", () => {
	const event = provider({
		type: "tool_call",
		content: [
			{
				type: "data",
				data: {
					authorization: { bearer: "synthetic-token", scopes: ["synthetic-scope"] },
					api_key: "synthetic-key",
					policy: { allowed: true },
					expires: 123,
					url: "https://example.test/api?token=synthetic-url&safe=yes",
				},
			},
		],
	});
	const data = sanitizeSessionEvent(event).content?.[0]?.data;
	expect(data).toEqual({
		authorization: { bearer: "[redacted]", scopes: ["[redacted]"] },
		api_key: "[redacted]",
		policy: { allowed: true },
		expires: 123,
		url: expect.stringContaining("[redacted]"),
	});
});

test("protocol identity slots do not exempt malformed object descendants", () => {
	const secret = "api_key=synthetic-nested";
	const nested = { code: secret, type: secret, event_id: secret };
	const event = provider(
		{
			type: "session_status",
			metadata: {
				session_thread_id: nested,
				pending_call_ids: [nested, [secret]],
				stop_reason: { type: nested, call_ids: [nested] },
				error: { code: nested },
			},
		},
		{ id: nested, msg_id: [secret], stop_reason: secret, error: { code: nested } },
	);
	const result = sanitizeSessionEvent(event, { includeRaw: true });
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(result.metadata?.pending_call_ids).toEqual([
		{ code: "api_key: [redacted]", type: "api_key: [redacted]", event_id: "api_key: [redacted]" },
		["api_key: [redacted]"],
	]);
	expect(result.metadata?.redacted).toBe(true);
});

test("structured truncation preserves objects, identities, and tool/document/raw length policies", () => {
	const id = `msg-token=synthetic-identity ${"i".repeat(4100)}`;
	const toolText = "t".repeat(8100);
	const document = `\`\`\`html\n${"d".repeat(32100)}`;
	const rawText = "r".repeat(16100);
	const event = provider(
		{
			event_id: id,
			type: "message",
			content: [
				{ type: "text", index: 7, text: document },
				{ type: "data", data: { output: { text: toolText } } },
			],
			code: id,
			metadata: {
				event_status: "completed",
				pending_call_ids: [id],
				session_thread_id: id,
				stop_reason: { type: "requires_action", call_ids: [id], event_ids: [id] },
				error: { code: id },
				artifacts: [{ file_id: id }],
				artifact: { file_id: id },
				nested: [{ description: "n".repeat(4100) }],
			},
		},
		{ msg_id: id, error: { code: id }, payload: { text: rawText } },
	);
	const result = sanitizeSessionEvent(event, { includeRaw: true });
	expect(result.event_id).toBe(id);
	expect(result.code).toBe(id);
	expect(result.metadata?.pending_call_ids).toEqual([id]);
	expect(result.metadata?.session_thread_id).toBe(id);
	expect(result.metadata?.stop_reason).toEqual({ type: "requires_action", call_ids: [id], event_ids: [id] });
	expect(result.metadata?.error).toEqual({ code: id });
	expect(result.metadata?.artifacts).toEqual([{ file_id: id }]);
	expect(result.metadata?.artifact).toEqual({ file_id: id });
	expect(result.metadata?.event_status).toBe("completed");
	expect(result.content?.[0]?.index).toBe(7);
	expect(result.content?.[0]?.text).toBe(
		`${document.slice(0, 32000)}\n...[truncated ${document.length - 32000} chars]`,
	);
	expect(result.content?.[1]?.data).toEqual({
		output: { text: `${toolText.slice(0, 8000)}\n...[truncated 100 chars]` },
	});
	expect(result.metadata?.nested).toEqual([{ description: `${"n".repeat(4000)}\n...[truncated 100 chars]` }]);
	expect(result.metadata?.raw).toEqual({
		msg_id: id,
		error: { code: id },
		payload: { text: `${rawText.slice(0, 16000)}\n...[truncated 100 chars]` },
	});
	expect(result.metadata?.truncated).toBe(true);
	expect(result.metadata?.redacted).toBeUndefined();
	expect(sanitizeSessionEvent(event, { redact: false, truncate: false, includeRaw: true })).toEqual({
		...event.snapshot,
		metadata: { ...event.snapshot?.metadata, raw: event.raw },
	});
});

test("error message and nested error details use snapshot policies without replacing error identity", () => {
	const event = provider({
		type: "error",
		code: "PERMISSION_DENIED",
		is_error: true,
		message: "token=synthetic-message",
		metadata: { error: { code: "DENIED", credential: "synthetic-credential" } },
	});
	const result = sanitizeSessionEvent({ ...event, type: "error" });
	expect(result).toEqual({
		type: "error",
		code: "PERMISSION_DENIED",
		is_error: true,
		message: "token: [redacted]",
		metadata: { error: { code: "DENIED", credential: "[redacted]" }, redacted: true },
	});
});

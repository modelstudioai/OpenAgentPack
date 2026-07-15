import { expect, test } from "bun:test";
import { sanitizeSessionEvent } from "../../src/internal/core/session-event-sanitizer.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

test("surfaces the artifact descriptor onto metadata.artifact", () => {
	const event: ProviderSessionEvent = {
		type: "unknown",
		raw_type: "agent.artifact_delivered",
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
		role: "assistant",
		content: "hello",
	};
	const result = sanitizeSessionEvent(event);
	expect(result.metadata?.artifact).toBeUndefined();
});

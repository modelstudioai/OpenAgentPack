import type { SessionEvent } from "@openagentpack/sdk";

export type DisplayBucket = "message" | "thinking" | "tool_use" | "tool_result" | "status" | "error" | "unknown";

const DISPLAY_BUCKETS = new Set<DisplayBucket>([
	"message",
	"thinking",
	"tool_use",
	"tool_result",
	"status",
	"error",
	"unknown",
]);

function bucketFromType(type: string): DisplayBucket {
	switch (type) {
		case "message":
		case "thread_message_sent":
		case "thread_message_received":
			return "message";
		case "reasoning":
			return "thinking";
		case "function_call":
		case "tool_call":
		case "mcp_call":
		case "tool_confirmation":
			return "tool_use";
		case "function_call_output":
		case "tool_call_output":
		case "mcp_call_output":
			return "tool_result";
		case "session_status":
		case "session_updated":
		case "thread_status":
		case "thread_created":
		case "model_request_start":
		case "model_request_end":
		case "define_outcome":
		case "outcome_evaluation":
		case "thread_context_compacted":
		case "interrupt":
			return "status";
		case "error":
			return "error";
		default:
			return "unknown";
	}
}

export function displayBucketOf(event: SessionEvent): DisplayBucket {
	// The sanitizer stamps metadata.display_bucket with the engine's 7-class bucket for every
	// event it classified, so this is the authoritative source. bucketFromType is only the
	// fallback for raw types the provider mapper left as "unknown" (no display_bucket).
	const hinted = event.metadata?.display_bucket;
	if (typeof hinted === "string" && DISPLAY_BUCKETS.has(hinted as DisplayBucket)) {
		return hinted as DisplayBucket;
	}
	if (event.is_error) return "error";
	return bucketFromType(event.type);
}

export function eventText(event: SessionEvent): string {
	if (!event.content) return "";
	const parts: string[] = [];
	for (const block of event.content) {
		if (block.type === "text" && typeof block.text === "string" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

export function eventData(event: SessionEvent): unknown {
	return event.content?.find((block) => block.type === "data")?.data;
}

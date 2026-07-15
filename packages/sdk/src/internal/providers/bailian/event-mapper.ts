// Pure Bailian raw-event → ProviderSessionEvent mapper. Type-only imports keep this module free
// of any Node/runtime dependency, so it is safe to bundle into a browser via the
// `@openagentpack/sdk/session-events` subpath (consumed by the webui console-direct transport).

import type { SessionEventType } from "../../types/dto.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";

const BAILIAN_EVENT_MAP: Record<string, SessionEventType> = {
	message: "message",
	thread_message_sent: "message",
	thread_message_received: "message",
	tool_call: "tool_use",
	function_call: "tool_use",
	mcp_call: "tool_use",
	tool_call_output: "tool_result",
	function_call_output: "tool_result",
	mcp_call_output: "tool_result",
	session_status: "status",
	reasoning: "thinking",
	error: "error",
};

export function toSessionEvent(raw: Record<string, unknown>): ProviderSessionEvent {
	const rawType = (raw.type as string) ?? "";
	const type: SessionEventType = BAILIAN_EVENT_MAP[rawType] ?? "unknown";

	const event: ProviderSessionEvent = { type, raw_type: rawType, raw };
	if (typeof raw.id === "string") event.id = raw.id;
	if (typeof raw.role === "string") event.role = raw.role;

	if (type === "message") {
		// Plain `message` events carry `role`, but the `thread_message_sent` /
		// `thread_message_received` variants may omit it — derive the actor from
		// the event type so consumers can always attribute the turn.
		if (event.role === undefined) {
			if (rawType === "thread_message_sent") event.role = "user";
			else if (rawType === "thread_message_received") event.role = "assistant";
		}
		event.content = extractContentText(raw);
	} else if (type === "tool_use") {
		const data = firstContentData(raw);
		event.tool_name = (data?.name as string) ?? "";
		event.tool_input = typeof data?.arguments === "string" ? data.arguments : JSON.stringify(data?.arguments ?? {});
	} else if (type === "tool_result") {
		const data = firstContentData(raw);
		event.tool_name = (data?.name as string) ?? "";
		if (data?.arguments !== undefined) {
			event.tool_input = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
		}
		event.content = extractContentText(raw);
	} else if (type === "status") {
		const data = firstContentData(raw);
		const status = data?.session_status ?? raw.status;
		if (typeof status === "string") event.status = status;
		event.stop_reason = extractStopReason(data?.stop_reason ?? raw.stop_reason);
	} else if (type === "error") {
		event.content = (raw.message as string) ?? extractContentText(raw);
	}

	// TODO(artifact-download, Mode B): bailian's `download_file` builtin flows through
	// tool_call/tool_call_output above — there is NO structured artifact-delivered event in the
	// current wire, and we have no real bailian delivery sample to confirm one. When such a sample
	// exists, populate `event.artifact = { file_id, filename, content_type, size }` here (mirroring
	// qoder/mapper.ts) so the shared sanitizer surfaces it as metadata.artifact and the webui shows
	// the same download card. Until then Mode B simply produces no artifact (graceful: no card).

	return event;
}

function extractContentText(raw: Record<string, unknown>): string {
	const content = raw.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: Record<string, unknown>) => {
				if (typeof c.text === "string") return c.text;
				const data = c.data as Record<string, unknown> | undefined;
				if (typeof data?.output === "string") return data.output;
				if (data?.output !== undefined) return JSON.stringify(data.output);
				return "";
			})
			.filter(Boolean)
			.join("");
	}
	return "";
}

function firstContentData(raw: Record<string, unknown>): Record<string, unknown> | undefined {
	const content = raw.content;
	if (Array.isArray(content) && content[0]?.data) {
		return content[0].data as Record<string, unknown>;
	}
	return undefined;
}

function extractStopReason(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const type = (value as Record<string, unknown>).type;
		if (typeof type === "string") return type;
	}
	return undefined;
}

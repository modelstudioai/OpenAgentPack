import type { SessionContentBlock } from "../../types/dto.ts";
import { BailianEventProtocolError, isRecord, normalizeContent } from "./snapshot-mapper.ts";

export interface ExpandedBailianEventFrame {
	event: Record<string, unknown>;
	/** Keep nested block fields separate from the stream envelope's own ID and status. */
	content?: SessionContentBlock;
}

/** Convert stream envelopes to the existing message/content accumulator vocabulary. */
export function expandBailianEventFrame(raw: Record<string, unknown>): ExpandedBailianEventFrame {
	if (raw.type === "event_start") {
		const { event, type: _type, ...envelope } = raw;
		if (
			!isRecord(event) ||
			typeof event.id !== "string" ||
			!event.id ||
			typeof event.type !== "string" ||
			!event.type
		) {
			throw new BailianEventProtocolError("Bailian event_start is missing its event identity.");
		}
		return {
			event: {
				...envelope,
				...event,
				...(isRecord(envelope.metadata) && isRecord(event.metadata)
					? { metadata: { ...envelope.metadata, ...event.metadata } }
					: {}),
				object: "message",
				status: "in_progress",
			},
		};
	}
	if (raw.type === "event_delta") {
		if (typeof raw.event_id !== "string" || !raw.event_id || !isRecord(raw.delta)) {
			throw new BailianEventProtocolError("Bailian event_delta is missing its event ID or delta.");
		}
		const delta = raw.delta;
		const content =
			delta.type === "reasoning_delta" && typeof delta.reasoning === "string"
				? { type: "text", text: delta.reasoning }
				: delta.type === "content_delta" && isRecord(delta.content)
					? normalizeContent([delta.content])[0]!
					: undefined;
		if (!content) throw new BailianEventProtocolError("Unsupported Bailian event_delta content.");
		return {
			event: { object: "content", msg_id: raw.event_id, index: delta.index, delta: true },
			content,
		};
	}
	return { event: raw };
}

export function isBailianEventFrame(raw: Record<string, unknown>): boolean {
	return raw.type === "event_start" || raw.type === "event_delta";
}

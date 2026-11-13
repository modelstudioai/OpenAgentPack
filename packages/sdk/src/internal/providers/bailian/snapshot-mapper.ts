import type { SessionContentBlock, SessionEvent } from "../../types/dto.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";

export interface BailianEventMappingOptions {
	event_format?: "legacy" | "snapshot";
}

/** Safe protocol error: never attach the provider payload to an error or message. */
export class BailianEventProtocolError extends Error {
	readonly code = "BAILIAN_EVENT_PROTOCOL_ERROR";
	constructor(message: string) {
		super(message);
		this.name = "BailianEventProtocolError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Provider events are JSON values; this also keeps explicit undefined fields intact. */
export function cloneEventValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map(cloneEventValue) as T;
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneEventValue(item)])) as T;
	}
	return value;
}

export function normalizeContent(value: unknown): SessionContentBlock[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) throw new BailianEventProtocolError("Invalid Bailian message content.");
	return value.map((block) => {
		if (!isRecord(block)) throw new BailianEventProtocolError("Invalid Bailian content block.");
		const result = cloneEventValue(block);
		if (typeof result.type !== "string") {
			if (typeof result.text === "string") result.type = "text";
			else if ("data" in result) result.type = "data";
			else throw new BailianEventProtocolError("Bailian content block is missing its type.");
		}
		if (result.text !== undefined && typeof result.text !== "string") {
			throw new BailianEventProtocolError("Invalid Bailian text block.");
		}
		return result as SessionContentBlock;
	});
}

const STRUCTURAL_FIELDS = new Set([
	"object",
	"id",
	"event_id",
	"type",
	"role",
	"created_at",
	"content",
	"metadata",
	"status",
	"is_error",
	"code",
	"message",
	"error",
]);
const DATA_METADATA_FIELDS = [
	"call_id",
	"server_label",
	"evaluated_permission",
	"stop_reason",
	"event_ids",
	"call_ids",
	"pending_batch_id",
	"pending_call_ids",
	"batch_id",
	"thread_id",
	"session_thread_id",
	"from_thread_id",
	"to_thread_id",
] as const;

export function attachSnapshot(event: ProviderSessionEvent, raw: Record<string, unknown>): ProviderSessionEvent {
	if (raw.object === "content") {
		throw new BailianEventProtocolError("Bailian content frames require a message accumulator.");
	}
	if (typeof raw.type !== "string" || raw.type.length === 0) {
		throw new BailianEventProtocolError("Bailian event is missing its type.");
	}
	const snapshot: SessionEvent = { type: raw.type };
	const id = typeof raw.id === "string" ? raw.id : raw.event_id;
	if (typeof id === "string") snapshot.event_id = event.id = id;
	if (event.role !== undefined) snapshot.role = event.role;
	if (typeof raw.created_at === "string") snapshot.created_at = raw.created_at;
	if (raw.content !== undefined) snapshot.content = normalizeContent(raw.content);
	const metadata: Record<string, unknown> = isRecord(raw.metadata) ? cloneEventValue(raw.metadata) : {};
	for (const [key, value] of Object.entries(raw)) {
		if (!STRUCTURAL_FIELDS.has(key) && value !== undefined) metadata[key] = cloneEventValue(value);
	}
	if (typeof raw.status === "string" && (raw.object === "message" || event.type !== "status")) {
		metadata.event_status = raw.status;
	}
	const dataBlocks = snapshot.content?.flatMap((block) => (isRecord(block.data) ? [block.data] : [])) ?? [];
	for (const data of dataBlocks) {
		for (const key of DATA_METADATA_FIELDS) {
			if (data[key] !== undefined && metadata[key] === undefined) metadata[key] = cloneEventValue(data[key]);
		}
	}
	const data = dataBlocks[0];
	if (event.type === "status") {
		// The message envelope's status is a lifecycle flag, never a session state.
		// Only legacy non-message envelopes put the session state directly in status.
		const status =
			data?.session_status ??
			raw.session_status ??
			metadata.status ??
			(raw.object !== "message" ? raw.status : undefined);
		delete event.status;
		if (typeof status === "string") metadata.status = event.status = status;
	}
	if (event.type === "tool_use" || event.type === "tool_result") {
		if (typeof data?.name === "string") metadata.tool_name = event.tool_name = data.name;
		if (data?.arguments !== undefined) {
			metadata.tool_input = cloneEventValue(data.arguments);
			event.tool_input = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments);
		}
	}
	const threadId = metadata.session_thread_id ?? metadata.thread_id;
	if (typeof threadId === "string") metadata.session_thread_id = event.session_thread_id = threadId;
	const error = isRecord(raw.error) ? raw.error : undefined;
	if (raw.error !== undefined) metadata.error = cloneEventValue(raw.error);
	if (typeof raw.is_error === "boolean" || raw.is_error === null) snapshot.is_error = raw.is_error;
	else if (typeof data?.is_error === "boolean") snapshot.is_error = data.is_error;
	else if (event.type === "error") snapshot.is_error = true;
	for (const key of ["code", "message"] as const) {
		const value = raw[key] ?? error?.[key];
		if (typeof value === "string" || value === null) snapshot[key] = value;
	}
	if (event.type === "thinking" || event.type === "message" || event.type === "tool_result") {
		event.content = contentText(snapshot.content);
	}
	if (event.type === "error" && typeof snapshot.message === "string") event.content = snapshot.message;
	snapshot.metadata = metadata;
	event.snapshot = snapshot;
	deriveArtifacts(event);
	return event;
}

export function contentText(content: SessionContentBlock[] | undefined): string {
	return (
		content
			?.map((block) => {
				if (typeof block.text === "string") return block.text;
				if (isRecord(block.data) && block.data.output !== undefined) {
					return typeof block.data.output === "string" ? block.data.output : JSON.stringify(block.data.output);
				}
				return "";
			})
			.join("") ?? ""
	);
}

/** Only an identified mark_artifacts result may create the SDK's derived file descriptors. */
export function deriveArtifacts(event: ProviderSessionEvent): void {
	const snapshot = event.snapshot;
	if (!snapshot || event.type !== "tool_result" || event.tool_name !== "mark_artifacts" || snapshot.is_error === true)
		return;
	const artifacts: Record<string, unknown>[] = [];
	for (const block of snapshot.content ?? []) {
		if (!isRecord(block.data)) continue;
		let output: unknown = block.data.output;
		if (typeof output === "string") {
			try {
				output = JSON.parse(output);
			} catch {
				continue;
			}
		}
		if (!isRecord(output) || !Array.isArray(output.marked)) continue;
		for (const item of output.marked) {
			if (!isRecord(item) || typeof item.file_id !== "string" || !item.file_id.trim()) continue;
			const artifact = cloneEventValue(item);
			artifact.file_id = item.file_id.trim();
			if (typeof artifact.filename !== "string" && typeof item.path === "string") {
				const name = item.path.split("/").pop();
				if (name) artifact.filename = name;
			}
			artifacts.push(artifact);
		}
	}
	if (!artifacts.length) return;
	snapshot.metadata ??= {};
	snapshot.metadata.artifacts = artifacts;
	snapshot.metadata.artifact = cloneEventValue(artifacts[0]);
	const first = artifacts[0]!;
	event.artifact = { file_id: first.file_id as string };
	if (typeof first.filename === "string") event.artifact.filename = first.filename;
	if (typeof first.content_type === "string") event.artifact.content_type = first.content_type;
	if (typeof first.size === "number") event.artifact.size = first.size;
}

// Pure ProviderSessionEvent → contract SessionEvent sanitizer. Type-only imports keep this
// module free of any Node/runtime dependency, so it is safe to bundle into a browser via the
// `@openagentpack/sdk/session-events` subpath.

import { redactSensitiveText } from "../../redaction.ts";
import type { SessionContentBlock, SessionEvent } from "../types/dto.ts";
import type { ProviderSessionEvent } from "../types/session-event.ts";

const DEFAULT_TEXT_LIMIT = 4000;
const TOOL_TEXT_LIMIT = 8000;
/** Self-contained rich documents (HTML/SVG/Mermaid) need much more room than chat text. */
const DOCUMENT_TEXT_LIMIT = 32_000;

/**
 * Lightweight check: does this message text contain a self-contained rich document?
 * Used by the sanitizer to pick a higher truncation limit so HTML reports, SVG
 * graphics and Mermaid diagrams survive transport intact.
 */
function hasDocumentContent(text: string): boolean {
	// Fenced document code block: ```html, ```svg, ```mermaid
	if (/```(?:html|htm|svg|mermaid)\s*\n/i.test(text)) return true;
	// Inline HTML document (DOCTYPE or <html tag)
	if (/<(?:!DOCTYPE\s+)?html[\s>]/i.test(text)) return true;
	return false;
}

export interface SessionEventSanitizerOptions {
	/** Include raw provider data using the selected redaction/truncation policies. Defaults to false. */
	includeRaw?: boolean;
	/** Apply sensitive-text redaction. Defaults to true; independent of truncation. */
	redact?: boolean;
	/** Apply the legacy text-size limits. Defaults to true; independent of redaction. */
	truncate?: boolean;
}

export function sanitizeSessionEvents(
	events: ProviderSessionEvent[],
	options: SessionEventSanitizerOptions = {},
): SessionEvent[] {
	return events.map((event) => sanitizeSessionEvent(event, options));
}

export function sanitizeSessionEvent(
	event: ProviderSessionEvent,
	options: SessionEventSanitizerOptions = {},
): SessionEvent {
	if (event.snapshot) return sanitizeSnapshot(event, event.snapshot, options);

	// Map the engine's (already 7-classified) provider event up to the snake_case
	// contract event, preserving the original Agents `type` via `raw_type` so no detail
	// is dropped. Transport concerns added here: secret redaction + truncation,
	// surfaced as `metadata.redacted` / `metadata.truncated` flags (the contract event
	// has no dedicated fields for them, so they live in the open metadata bag where the
	// presentation layer can read them uniformly).
	const isToolEvent = event.type === "tool_result" || event.type === "tool_use";
	const primarySource = event.content ?? (event.type === "tool_use" ? event.tool_input : undefined);
	// Preserve the existing limits unless the caller explicitly requests complete content.
	const textLimit =
		options.truncate === false
			? Number.POSITIVE_INFINITY
			: isToolEvent
				? TOOL_TEXT_LIMIT
				: typeof primarySource === "string" && hasDocumentContent(primarySource)
					? DOCUMENT_TEXT_LIMIT
					: DEFAULT_TEXT_LIMIT;
	const rawLimit = options.truncate === false ? Number.POSITIVE_INFINITY : TOOL_TEXT_LIMIT * 2;
	const shouldRedact = options.redact !== false;
	const primary = sanitizeOptionalText(primarySource, textLimit, shouldRedact);
	const raw = options.includeRaw ? sanitizeUnknown(event.raw, rawLimit, shouldRedact) : undefined;
	// Keep the tool input's existing length while applying the same policy to its metadata copy.
	const toolInput =
		shouldRedact && event.tool_input !== undefined ? redactSensitiveText(event.tool_input) : event.tool_input;
	const redacted = Boolean(primary?.redacted || raw?.redacted || toolInput !== event.tool_input);
	const truncated = Boolean(primary?.truncated || raw?.truncated);

	const content: SessionContentBlock[] = [];
	if (primary?.value !== undefined) content.push({ type: "text", text: primary.value });

	const metadata: Record<string, unknown> = {};
	if (event.tool_name !== undefined) metadata.tool_name = event.tool_name;
	if (toolInput !== undefined) metadata.tool_input = toolInput;
	if (event.status !== undefined) metadata.status = event.status;
	if (event.stop_reason !== undefined) metadata.stop_reason = event.stop_reason;
	if (event.session_thread_id !== undefined) metadata.session_thread_id = event.session_thread_id;
	// Always surface the engine's 7-class bucket so the renderer never has to re-derive it
	// for events the provider already classified. For unmapped raw types (type==="unknown")
	// we omit it on purpose, leaving the renderer to bucket by raw_type — its Agents-vocab table
	// is the fallback for raw types the provider mapper doesn't cover.
	if (event.type !== "unknown") metadata.display_bucket = event.type;
	// A delivered artifact file (qoder DeliverArtifacts). Surface the structured descriptor so the
	// webui can render a download card and fetch a presigned URL on demand — no free-text scraping.
	if (event.artifact) metadata.artifact = event.artifact;
	if (redacted) metadata.redacted = true;
	if (truncated) metadata.truncated = true;
	if (raw !== undefined) metadata.raw = raw.value;

	const result: SessionEvent = { type: event.raw_type };
	if (event.role !== undefined) result.role = event.role;
	if (content.length > 0) result.content = content;
	if (Object.keys(metadata).length > 0) result.metadata = metadata;
	if (event.type === "error") {
		result.is_error = true;
		if (primary?.value) result.message = primary.value;
	}
	return result;
}

/** Sanitize JSON-shaped snapshots without destroying their content-block structure. */
function sanitizeSnapshot(
	event: ProviderSessionEvent,
	snapshot: SessionEvent,
	options: SessionEventSanitizerOptions,
): SessionEvent {
	// These three keys are sanitizer output, not provider-supplied policy decisions. Raw
	// always comes from the triggering frame, never an older cumulative snapshot.
	const { raw: _raw, redacted: _redacted, truncated: _truncated, ...metadata } = snapshot.metadata ?? {};
	const source = { ...snapshot, ...(snapshot.metadata === undefined ? {} : { metadata }) };
	const policies: StructuredPolicies = {
		redact: options.redact !== false,
		truncate: options.truncate !== false,
		tool: event.type === "tool_use" || event.type === "tool_result",
		raw: false,
	};
	const sanitized = sanitizeStructured(source, policies);
	const result = sanitized.value as SessionEvent;
	const raw = options.includeRaw ? sanitizeStructured(event.raw, { ...policies, raw: true }, "raw") : undefined;
	if (raw || sanitized.redacted || sanitized.truncated) {
		result.metadata ??= {};
		if (raw) result.metadata.raw = raw.value;
		if (sanitized.redacted || raw?.redacted) result.metadata.redacted = true;
		if (sanitized.truncated || raw?.truncated) result.metadata.truncated = true;
	}
	return result;
}

interface StructuredPolicies {
	redact: boolean;
	truncate: boolean;
	tool: boolean;
	raw: boolean;
}

// Keep these names aligned with redactSensitiveText's key/value policy. URL query
// fields continue to be handled by redactSensitiveText inside each string leaf.
// Recognizing the key separately is necessary because a JSON string leaf contains
// only its value (for example { api_key: "secret-value" }), not "api_key=...".
const SENSITIVE_FIELD =
	/^(?:api[_-]?key|access[_-]?key(?:_id)?|authorization|credential|ossaccesskeyid|secret|signature|token|security-token)$/i;
const TOOL_PAYLOAD_FIELD = /^(?:arguments|output|tool_input|tool_output)$/;

type StructuredLocation =
	| "event"
	| "raw"
	| "metadata"
	| "blocks"
	| "block"
	| "data"
	| "stop_reason"
	| "error"
	| "artifacts"
	| "artifact"
	| "identity"
	| "identities"
	| "unknown";

const EVENT_IDENTITY_FIELDS = new Set(["event_id", "type", "role", "created_at", "code"]);
const RAW_IDENTITY_FIELDS = new Set(["id", "msg_id", "status", "index", "delta"]);
const DATA_IDENTITY_FIELDS = new Set([
	"call_id",
	"event_ids",
	"call_ids",
	"pending_batch_id",
	"pending_call_ids",
	"batch_id",
	"thread_id",
	"session_thread_id",
	"from_thread_id",
	"to_thread_id",
]);
const METADATA_IDENTITY_FIELDS = new Set(["event_status", "status", "display_bucket"]);
const IDENTITY_ARRAY_FIELDS = new Set(["event_ids", "call_ids", "pending_call_ids"]);

/** Protocol identities are recognized by position, never by arbitrary payload keys. */
function childLocation(parent: StructuredLocation, key: string): StructuredLocation {
	if (parent === "event" || parent === "raw") {
		if (EVENT_IDENTITY_FIELDS.has(key) || (parent === "raw" && RAW_IDENTITY_FIELDS.has(key))) return "identity";
		if (key === "metadata") return "metadata";
		if (key === "content") return "blocks";
		if (parent === "event") return "unknown";
		if (key === "data") return "data";
	}
	if (parent === "metadata" && METADATA_IDENTITY_FIELDS.has(key)) return "identity";
	if (parent === "raw" || parent === "metadata" || parent === "data") {
		if (DATA_IDENTITY_FIELDS.has(key)) return IDENTITY_ARRAY_FIELDS.has(key) ? "identities" : "identity";
		if (key === "stop_reason") return "stop_reason";
	}
	if (parent === "raw" || parent === "metadata") {
		if (key === "error") return "error";
		if (key === "artifact" || key === "artifacts") return key;
	}
	if (parent === "block") {
		if (key === "type" || key === "index") return "identity";
		if (key === "data") return "data";
	}
	if (parent === "stop_reason") {
		if (key === "type") return "identity";
		if (key === "call_ids" || key === "event_ids") return "identities";
	}
	if ((parent === "error" && key === "code") || (parent === "artifact" && key === "file_id")) return "identity";
	return "unknown";
}

function sanitizeStructured(
	value: unknown,
	policies: StructuredPolicies,
	location: StructuredLocation = "event",
	sensitive = false,
): SanitizedValue<unknown> {
	if (Array.isArray(value)) {
		const entryLocation =
			location === "blocks"
				? "block"
				: location === "artifacts"
					? "artifact"
					: location === "identities"
						? "identity"
						: "unknown";
		const children = value.map((entry) => sanitizeStructured(entry, policies, entryLocation, sensitive));
		return {
			value: children.map((entry) => entry.value),
			redacted: children.some((entry) => entry.redacted),
			truncated: children.some((entry) => entry.truncated),
		};
	}
	if (value !== null && typeof value === "object") {
		const children = Object.entries(value).map(
			([childKey, entry]) =>
				[
					childKey,
					sanitizeStructured(
						entry,
						TOOL_PAYLOAD_FIELD.test(childKey) ? { ...policies, tool: true } : policies,
						childLocation(location, childKey),
						sensitive || SENSITIVE_FIELD.test(childKey),
					),
				] as const,
		);
		return {
			value: Object.fromEntries(children.map(([childKey, entry]) => [childKey, entry.value])),
			redacted: children.some(([, entry]) => entry.redacted),
			truncated: children.some(([, entry]) => entry.truncated),
		};
	}
	if (policies.redact && sensitive && value !== undefined && value !== null) {
		return { value: "[redacted]", redacted: value !== "[redacted]", truncated: false };
	}
	if (typeof value !== "string" || location === "identity") {
		return { value, redacted: false, truncated: false };
	}
	const limit = !policies.truncate
		? Number.POSITIVE_INFINITY
		: policies.raw
			? TOOL_TEXT_LIMIT * 2
			: policies.tool
				? TOOL_TEXT_LIMIT
				: hasDocumentContent(value)
					? DOCUMENT_TEXT_LIMIT
					: DEFAULT_TEXT_LIMIT;
	return sanitizeText(value, limit, policies.redact);
}

function sanitizeOptionalText(
	value: string | undefined,
	limit: number,
	shouldRedact: boolean,
): SanitizedValue<string> | undefined {
	if (value === undefined) return undefined;
	return sanitizeText(value, limit, shouldRedact);
}

interface SanitizedValue<T> {
	value: T;
	redacted: boolean;
	truncated: boolean;
}

function sanitizeUnknown(value: unknown, limit: number, shouldRedact: boolean): SanitizedValue<unknown> {
	if (typeof value === "string") return sanitizeText(value, limit, shouldRedact);
	if (value === null || typeof value !== "object") {
		return {
			value,
			redacted: false,
			truncated: false,
		};
	}

	const serialized = safeStringify(value);
	const sanitized = sanitizeText(serialized, limit, shouldRedact);
	return {
		...sanitized,
		value: parseJsonOrText(sanitized.value),
	};
}

function sanitizeText(value: string, limit: number, shouldRedact: boolean): SanitizedValue<string> {
	const redacted = shouldRedact ? redactSensitiveText(value) : value;
	if (redacted.length <= limit) {
		return { value: redacted, redacted: redacted !== value, truncated: false };
	}

	// When the content is HTML, try to truncate at a tag boundary to avoid splitting
	// an open tag (which would cause the browser to treat all subsequent text as a
	// single malformed element).
	let cut = limit;
	if (/<[a-z][\s\S]*>/i.test(redacted)) {
		const lastLt = redacted.lastIndexOf("<", cut);
		const lastGt = redacted.lastIndexOf(">", cut);
		if (lastLt > lastGt) {
			// We're inside an unclosed tag — back up to before the `<`.
			cut = lastLt;
		}
	}

	return {
		value: `${redacted.slice(0, cut)}\n...[truncated ${redacted.length - cut} chars]`,
		redacted: redacted !== value,
		truncated: true,
	};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function parseJsonOrText(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

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

export function sanitizeSessionEvents(
	events: ProviderSessionEvent[],
	options: { includeRaw?: boolean } = {},
): SessionEvent[] {
	return events.map((event) => sanitizeSessionEvent(event, options));
}

export function sanitizeSessionEvent(
	event: ProviderSessionEvent,
	options: { includeRaw?: boolean } = {},
): SessionEvent {
	// Map the engine's (already 7-classified) provider event up to the snake_case
	// contract event, preserving the original Agents `type` via `raw_type` so no detail
	// is dropped. Transport concerns added here: secret redaction + truncation,
	// surfaced as `metadata.redacted` / `metadata.truncated` flags (the contract event
	// has no dedicated fields for them, so they live in the open metadata bag where the
	// presentation layer can read them uniformly).
	const isToolEvent = event.type === "tool_result" || event.type === "tool_use";
	const primarySource = event.content ?? (event.type === "tool_use" ? event.tool_input : undefined);
	// Pick a truncation limit appropriate to the content: tool events get 8 000 chars,
	// message events containing self-contained documents get 32 000, everything else 4 000.
	const textLimit = isToolEvent
		? TOOL_TEXT_LIMIT
		: typeof primarySource === "string" && hasDocumentContent(primarySource)
			? DOCUMENT_TEXT_LIMIT
			: DEFAULT_TEXT_LIMIT;
	const primary = sanitizeOptionalText(primarySource, textLimit);
	const raw = options.includeRaw ? sanitizeUnknown(event.raw, TOOL_TEXT_LIMIT * 2) : undefined;
	const redacted = Boolean(primary?.redacted || raw?.redacted);
	const truncated = Boolean(primary?.truncated || raw?.truncated);

	const content: SessionContentBlock[] = [];
	if (primary?.value !== undefined) content.push({ type: "text", text: primary.value });

	const metadata: Record<string, unknown> = {};
	if (event.tool_name !== undefined) metadata.tool_name = event.tool_name;
	if (event.tool_input !== undefined) metadata.tool_input = event.tool_input;
	if (event.status !== undefined) metadata.status = event.status;
	if (event.stop_reason !== undefined) metadata.stop_reason = event.stop_reason;
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

function sanitizeOptionalText(value: string | undefined, limit: number): SanitizedValue<string> | undefined {
	if (value === undefined) return undefined;
	return sanitizeText(value, limit);
}

interface SanitizedValue<T> {
	value: T;
	redacted: boolean;
	truncated: boolean;
}

function sanitizeUnknown(value: unknown, limit: number): SanitizedValue<unknown> {
	if (typeof value === "string") return sanitizeText(value, limit);
	if (value === null || typeof value !== "object") {
		return {
			value,
			redacted: false,
			truncated: false,
		};
	}

	const serialized = safeStringify(value);
	const sanitized = sanitizeText(serialized, limit);
	return {
		...sanitized,
		value: parseJsonOrText(sanitized.value),
	};
}

function sanitizeText(value: string, limit: number): SanitizedValue<string> {
	const redacted = redactSensitiveText(value);
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

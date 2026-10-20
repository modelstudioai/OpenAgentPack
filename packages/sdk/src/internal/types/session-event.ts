import type { SessionEvent, SessionEventType } from "./dto.ts";

export interface ProviderSessionEvent {
	/** Opt-in cumulative contract snapshot. raw remains the actual triggering provider frame. */
	snapshot?: SessionEvent;
	type: SessionEventType;
	raw_type: string;
	/** Stable per-event id when the provider supplies one; used to de-dupe history replay vs. live stream. */
	id?: string;
	role?: string;
	content?: string;
	tool_name?: string;
	tool_input?: string;
	status?: string;
	stop_reason?: string;
	/** Child-agent thread id when a Managed Agents multi-agent event carries one. */
	session_thread_id?: string;
	/**
	 * A file the agent delivered to the provider's Files API (qoder DeliverArtifacts /
	 * bailian download_file). Structured so the webui can show a download card without
	 * scraping tool-result free text. Populated by the provider mapper; surfaced onto the
	 * contract event as `metadata.artifact` by the shared sanitizer.
	 */
	artifact?: { file_id: string; filename?: string; content_type?: string; size?: number };
	raw: Record<string, unknown>;
}

export type SessionEventFormat = "legacy" | "snapshot";

export interface EventListOptions {
	/** Bailian structured event conversion; defaults to legacy. */
	event_format?: SessionEventFormat;
	signal?: AbortSignal;
	limit?: number;
	after_id?: string;
	// Opaque forward cursor echoed verbatim from a prior response's `next_page`.
	order?: string;
	page_token?: string;
	/** Legacy alias for page_token used by some provider adapters. */
	page?: string;
	types?: string[];
	created_at_gt?: string;
	created_at_gte?: string;
	created_at_lt?: string;
	created_at_lte?: string;
}

export interface EventStreamOptions {
	after_id?: string;
	/** Bailian only. Nonempty event_deltas selects snapshot unless explicitly conflicting. */
	event_format?: SessionEventFormat;
	event_deltas?: ("message" | "reasoning")[];
	signal?: AbortSignal;
	/** Called once per successful connection, before the first business event. */
	onReady?: () => void;
	/** Bailian snapshot mode only; defaults to false. Never resends a user message. */
	reconnect?: boolean;
	/** Snapshot mode default: 30 seconds. */
	connectTimeoutMs?: number;
	/** Snapshot mode default: 180 seconds; comments and heartbeats count as activity. */
	idleTimeoutMs?: number;
}

export interface ProviderSessionEventList {
	events: ProviderSessionEvent[];
	has_more: boolean;
	// Opaque cursor for the next page; undefined/null when this is the last page.
	next_page?: string;
}

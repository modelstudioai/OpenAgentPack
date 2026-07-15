import type { SessionEventType } from "./dto.ts";

export interface ProviderSessionEvent {
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
	/**
	 * A file the agent delivered to the provider's Files API (qoder DeliverArtifacts /
	 * bailian download_file). Structured so the webui can show a download card without
	 * scraping tool-result free text. Populated by the provider mapper; surfaced onto the
	 * contract event as `metadata.artifact` by the shared sanitizer.
	 */
	artifact?: { file_id: string; filename?: string; content_type?: string; size?: number };
	raw: Record<string, unknown>;
}

export interface EventListOptions {
	limit?: number;
	after_id?: string;
	// Opaque forward cursor echoed verbatim from a prior response's `next_page`.
	order?: string;
	page_token?: string;
	/** Legacy alias for page_token used by some provider adapters. */
	page?: string;
}

export interface EventStreamOptions {
	after_id?: string;
}

export interface ProviderSessionEventList {
	events: ProviderSessionEvent[];
	has_more: boolean;
	// Opaque cursor for the next page; undefined/null when this is the last page.
	next_page?: string;
}

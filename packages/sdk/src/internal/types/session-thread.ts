import type { CursorListOptions, CursorPage } from "./managed-api.ts";

/** A child Agent execution within a Session; the main thread is not a resource in this list. */
export interface SessionThread {
	id: string;
	type: "session_thread";
	session_id: string;
	parent_thread_id: string;
	agent: { id: string; version?: number; name?: string };
	/** Provider status, currently running, idle, or terminated. Unknown future values are preserved. */
	status: string;
	created_at: string;
	updated_at: string;
	archived_at?: string | null;
	agent_name?: string;
}

export interface SessionThreadListOptions extends CursorListOptions {
	signal?: AbortSignal;
}

export type SessionThreadPage = CursorPage<SessionThread>;

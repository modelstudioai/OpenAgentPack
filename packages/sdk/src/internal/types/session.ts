export interface SessionFileResource {
	file_id: string;
	// Sandbox path the uploaded file mounts at. The provider rejects a file resource
	// without it ("file resource requires file_id and mount_path").
	mount_path: string;
}

interface CommonSessionBindings {
	/** Uploaded files to mount in the session sandbox. */
	files?: SessionFileResource[];
	title?: string;
	metadata?: Record<string, string>;
}

export interface ManagedSessionBindings extends CommonSessionBindings {
	/** Omitted for backward compatibility; omitted always means managed. */
	delivery?: "managed";
	agent_id: string;
	agent_version?: number;
	/** Cloud sandbox id. Every provider runs sessions inside an environment. */
	environment_id: string;
	/** Qoder BYOC tunnel id. Required to reach internal MCP servers from the sandbox. */
	tunnel_id?: string;
	vault_ids: string[];
	memory_store_ids: string[];
}

export interface ForwardSessionBindings extends CommonSessionBindings {
	delivery: "forward";
	/** Qoder Forward Template selected from the applied Agent materialization. */
	template_id: string;
	/** Existing business Identity supplied by the session caller; omitted uses the provider's default Identity. */
	identity_id?: string;
}

export type SessionBindings = ManagedSessionBindings | ForwardSessionBindings;

export interface ProviderSessionInfo {
	id: string;
	agent_id: string;
	environment_id: string;
	tunnel_id?: string;
	status: string;
	title?: string;
	vault_ids: string[];
	memory_store_ids: string[];
	created_at: string;
	updated_at: string;
	attributes: Record<string, unknown>;
}

export interface SessionFilter {
	agent_id?: string;
	limit?: number;
	// Opaque forward cursor echoed verbatim from a prior response's `next_page`.
	page?: string;
}

export interface SessionListResult {
	sessions: ProviderSessionInfo[];
	has_more: boolean;
	// Opaque cursor for the next page; undefined/null when this is the last page.
	next_page?: string;
}

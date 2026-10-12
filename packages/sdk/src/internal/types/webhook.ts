/** Fields returned for a workspace Webhook endpoint. Signing secrets are separate. */
export interface WebhookEndpoint {
	id: string;
	description: string | null;
	url: string;
	events: string[];
	status: "ACTIVE" | "DISABLED";
	disabled_reason: string | null;
	consecutive_fail: number;
	last_success_at: string | null;
	last_failure_at: string | null;
	created_at: string;
	updated_at: string;
	/** Present on individual endpoint responses, absent on list entries. */
	request_id?: string;
}

export interface CreateWebhookEndpointInput {
	url: string;
	events: string[];
	description?: string;
}

/** Omitted fields are unchanged; events replaces the full subscription array. */
export interface UpdateWebhookEndpointInput {
	url?: string;
	events?: string[];
	/** null and the empty string both clear the description. */
	description?: string | null;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
	/** Returned only once, on creation. Hosts must deliver it without logging or persisting it implicitly. */
	signing_secret: string;
	request_id: string;
}

/** The endpoint list is not paginated. */
export interface WebhookEndpointList {
	data: WebhookEndpoint[];
	request_id: string;
}

export interface WebhookDeleteResult {
	request_id: string;
}

export interface WebhookSecretResetResult {
	id: string;
	/** Returned only once; the previous secret is invalidated by the server. */
	signing_secret: string;
	updated_at: string;
	request_id: string;
}

export interface WebhookEventData {
	id: string;
	type: string;
	workspace_id: string;
	session_thread_id?: string;
	vault_id?: string;
	[field: string]: unknown;
}

export interface WebhookEvent {
	type: "event";
	id: string;
	created_at: string;
	data: WebhookEventData;
}

export interface WebhookTestResult extends WebhookEvent {
	request_id: string;
}

export interface WebhookDelivery {
	webhook_id: string;
	/** The provider owns delivery states; do not assume a closed set of values. */
	status: string;
	attempt_count: number;
	delivery_at: string | null;
	finish_at: string | null;
	failure_reason: string | null;
}

export interface WebhookEventWithDelivery extends WebhookEvent {
	delivery: WebhookDelivery;
}

/** Preserve the opaque nullable cursor and request ID, without synthesizing has_more. */
export interface WebhookEventPage {
	data: WebhookEventWithDelivery[];
	next_page: string | null;
	request_id: string;
}

export interface WebhookRequestOptions {
	provider?: string;
	signal?: AbortSignal;
}

export interface WebhookEventListOptions extends WebhookRequestOptions {
	/** Provider default is 20; supported values are 1 through 100. */
	limit?: number;
	page?: string;
}

import { UserError } from "../../errors.ts";

const AGENTSTUDIO_API_PATH = "/api/v1/agentstudio";

export interface ResolveBailianApiBaseUrlOptions {
	/** An HTTP(S) origin or a URL already ending in /api/v1/agentstudio. */
	baseUrl?: string;
	/** Used to construct the Beijing workspace endpoint when baseUrl is absent. */
	workspaceId?: string;
}

/** Normalize workspace API endpoints without changing BailianClient's verbatim baseUrl contract. */
export function resolveBailianApiBaseUrl(options: ResolveBailianApiBaseUrlOptions): string {
	if (options.baseUrl !== undefined) {
		let endpoint: URL;
		try {
			endpoint = new URL(options.baseUrl);
		} catch {
			throw new UserError("Bailian API base URL must be an HTTP(S) origin or AgentStudio API URL.");
		}
		const pathname = endpoint.pathname.replace(/\/+$/, "");
		if (
			!/^https?:$/.test(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			(pathname !== "" && pathname !== AGENTSTUDIO_API_PATH)
		) {
			throw new UserError(
				"Bailian API base URL must be an HTTP(S) origin or AgentStudio API URL without credentials, query, or fragment.",
			);
		}
		return `${endpoint.origin}${AGENTSTUDIO_API_PATH}`;
	}
	const workspaceId = options.workspaceId;
	if (!workspaceId || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(workspaceId)) {
		throw new UserError("Bailian workspace API requires a base URL or a valid workspace ID.");
	}
	return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com${AGENTSTUDIO_API_PATH}`;
}

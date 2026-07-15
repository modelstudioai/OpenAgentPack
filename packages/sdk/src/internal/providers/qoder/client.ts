import { BaseApiClient } from "../base-client.ts";

export interface QoderClientConfig {
	apiKey: string;
	gateway?: string;
}

export class QoderClient extends BaseApiClient {
	protected baseUrl: string;
	protected errorPrefix = "Qoder API";
	protected paginationStrategy = "after_id" as const;
	private apiKey: string;

	constructor(config: QoderClientConfig) {
		super();
		this.baseUrl = config.gateway ?? "https://api.qoder.com/api/v1/cloud";
		this.apiKey = config.apiKey;
	}

	protected headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}
}

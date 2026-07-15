import { BaseApiClient } from "../base-client.ts";

export interface ArkClientConfig {
	apiKey: string;
}

export class ArkClient extends BaseApiClient {
	protected baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
	protected errorPrefix = "Ark API";
	protected paginationStrategy = "page" as const;
	private apiKey: string;

	constructor(config: ArkClientConfig) {
		super();
		this.apiKey = config.apiKey;
	}

	protected headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	protected override isConflict(status: number, body: string): boolean {
		if (status === 409) return true;
		return /ResourceConflict|already exists/i.test(body);
	}
}

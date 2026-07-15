import { BaseApiClient } from "../base-client.ts";

export interface ClaudeClientConfig {
	apiKey: string;
	beta?: string;
}

export class ClaudeClient extends BaseApiClient {
	protected baseUrl = "https://api.anthropic.com/v1";
	protected errorPrefix = "Claude API";
	protected paginationStrategy = "page" as const;
	private apiKey: string;
	private beta: string;

	constructor(config: ClaudeClientConfig) {
		super();
		this.apiKey = config.apiKey;
		this.beta = config.beta ?? "managed-agents-2026-04-01,skills-2025-10-02,files-api-2025-04-14";
	}

	protected headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"X-Api-Key": this.apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": this.beta,
		};
	}
}

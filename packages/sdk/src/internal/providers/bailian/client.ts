import { UserError } from "../../errors.ts";
import { BaseApiClient } from "../base-client.ts";

export interface BailianClientConfig {
	apiKey: string;
	workspaceId?: string;
	baseUrl?: string;
}

export class BailianClient extends BaseApiClient {
	protected baseUrl: string;
	protected errorPrefix = "Bailian API";
	protected paginationStrategy = "page" as const;
	private apiKey: string;

	constructor(config: BailianClientConfig) {
		super();
		this.apiKey = config.apiKey;
		if (config.baseUrl) {
			this.baseUrl = config.baseUrl;
		} else if (config.workspaceId) {
			this.baseUrl = `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`;
		} else {
			throw new UserError("bailian provider requires either base_url or workspace_id");
		}
	}

	protected headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	protected override isConflict(status: number, body: string): boolean {
		if (status === 409) return true;
		if (/11300026/.test(body)) return true;
		if (/已存在/.test(body)) return true;
		if (/already exists/i.test(body)) return true;
		return false;
	}
}

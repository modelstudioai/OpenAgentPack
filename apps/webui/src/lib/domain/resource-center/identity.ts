import { getPlaybookAppId, PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "@openagentpack/playbooks";
import type { CloudAgent } from "@openagentpack/sdk";
import type { IdentityStamp } from "./types";

export function identityOf(agent: CloudAgent): IdentityStamp {
	const meta = agent.metadata ?? {};
	if (meta[PLAYBOOK_APP_METADATA_KEY] === getPlaybookAppId() && meta[PLAYBOOK_METADATA_KEY]) return "playbook";
	if (meta["agents.project"] || meta["agents.resource"]) return "agents";
	return "none";
}

export function isCurrentAppAgent(agent: CloudAgent): boolean {
	return agent.metadata?.[PLAYBOOK_APP_METADATA_KEY] === getPlaybookAppId();
}

export function modelId(model: CloudAgent["model"]): string | undefined {
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && "id" in model) {
		const id = (model as { id?: unknown }).id;
		return typeof id === "string" ? id : undefined;
	}
	return undefined;
}

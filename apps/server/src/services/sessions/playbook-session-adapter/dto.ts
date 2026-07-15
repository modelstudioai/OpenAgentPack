import { getPlaybookAppId, PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "@openagentpack/playbooks";
import type { ProviderSessionInfo, Session } from "@openagentpack/sdk";
import type { CompiledAgentRuntime } from "@/services/agents/catalog";

export function agentMetadataOf(compiled: CompiledAgentRuntime): Record<string, string> {
	return {
		"agents.webui.app_id": getPlaybookAppId(),
		"agents.webui.playbook_id": compiled.agent.id,
		"agents.webui.agent_version": "1",
		"agents.webui.agent_config_hash": compiled.agentConfigHash,
		[PLAYBOOK_APP_METADATA_KEY]: getPlaybookAppId(),
		[PLAYBOOK_METADATA_KEY]: compiled.agent.id,
	};
}

export function toSession(session: ProviderSessionInfo, agentId: string): Session {
	const metadata = extractSessionMetadata(session.attributes);
	const versionRaw = metadata["agents.webui.agent_version"];
	const version = versionRaw !== undefined && Number.isFinite(Number(versionRaw)) ? Number(versionRaw) : undefined;
	const result: Session = {
		session_id: session.id,
		status: session.status,
		title: session.title?.trim() || session.id,
		agent: { agent_id: session.agent_id || agentId, version },
		environment_id: session.environment_id,
		created_at: session.created_at,
		updated_at: session.updated_at,
	};
	if (Object.keys(metadata).length > 0) result.metadata = metadata;
	return result;
}

export function sortByUpdatedDesc(a: Session, b: Session): number {
	return Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "");
}

function extractSessionMetadata(attributes: Record<string, unknown>): Record<string, string> {
	const metadata = readRecord(attributes.metadata) ?? readRecord(attributes.attributes)?.metadata;
	if (!metadata || typeof metadata !== "object") return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

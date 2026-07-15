import { PLAYBOOK_AGENT_NAME_PREFIX } from "@openagentpack/playbooks";
import type { CloudAgent, Session } from "@openagentpack/sdk";
import { getApiCloudAgents, getApiSessions } from "../../api/client";
import { formatApiErrorMessage } from "../../api/error-message";
import { fetchEnvironments } from "../environment";
import { listFiles } from "../file-api";
import { listOfficialSkills, listSkills as listOwnedSkills } from "../skill-api";
import { fetchVaults } from "../vault";
import { deriveResourceCenter } from "./agents";
import { isCurrentAppAgent } from "./identity";
import { toEpoch } from "./shared";
import type { ResourceCenterView } from "./types";

/**
 * Build the resource-center view from raw cloud agents + the project-scoped session list
 * (sessions of the Agents family). This is the cloud-only resource view: it
 * intentionally surfaces same-name duplicates,
 * identity-stamp drift, and locally-defined playbooks that were never created in the cloud.
 * Transport-agnostic — the REST transport feeds the snake_case SDK shape directly.
 */
export async function fetchResourceCenter(prefix = PLAYBOOK_AGENT_NAME_PREFIX): Promise<ResourceCenterView> {
	const [{ familyAgents, sessions }, environments, vaults, files, skills, officialSkills] = await Promise.all([
		fetchProjectAgentsAndSessions(prefix),
		fetchEnvironments(),
		// Vaults are peripheral to the agent/session ledger; a vault-RPC hiccup shouldn't blank the
		// whole page, so degrade to [] rather than rejecting the Promise.all.
		fetchVaults().catch(() => []),
		// Files are likewise peripheral — degrade to [] so a Files-API hiccup doesn't blank the page.
		listFiles().catch(() => []),
		// Skills are likewise peripheral — degrade to [] so a Skills-API hiccup doesn't blank the page.
		listOwnedSkills().catch(() => []),
		// Official catalog is peripheral too — degrade to [] so it never blanks the page.
		listOfficialSkills().catch(() => []),
	]);
	// The agents table renders the active family only; archived members still feed session
	// scoping + name annotation (see fetchProjectAgentsAndSessions).
	const activeAgents = familyAgents.filter((a) => !a.archived_at);

	return deriveResourceCenter(
		activeAgents,
		sessions,
		familyAgents,
		environments,
		vaults,
		files,
		skills,
		officialSkills,
	);
}

// listAgents returns the whole current-app Agents/ family INCLUDING archived tombstones. Two consumers
// want different scopes: the resource center is an audit ledger that keeps an archived agent's session
// history (scoping + name annotation), so it pages the WHOLE family (includeArchived: default true).
// The homepage task list is "my current tasks" — archiving a role (soft-delete) should drop its tasks
// from that list — so it passes includeArchived: false to fan out over active agents only.
async function fetchProjectAgentsAndSessions(
	prefix = PLAYBOOK_AGENT_NAME_PREFIX,
	options: { includeArchived?: boolean } = {},
): Promise<{ familyAgents: CloudAgent[]; sessions: Session[] }> {
	const includeArchived = options.includeArchived ?? true;
	const agentsRes = await getApiCloudAgents({ query: { prefix } });
	if (agentsRes.error) throw new Error(formatApiErrorMessage(agentsRes.error, "读取云端 Agent 失败"));
	const familyAgents = (agentsRes.data?.agents ?? []).filter(isCurrentAppAgent);
	// Sessions are scoped by their owning agent's id; only fan out over agents in scope. Dropping
	// archived agents here both hides their sessions from the homepage and shrinks the listSessions
	// fan-out. The full familyAgents (incl. archived) is still returned for the caller's own use.
	const scopedAgents = includeArchived ? familyAgents : familyAgents.filter((a) => !a.archived_at);
	const sessions = await fetchSessionsForAgents(scopedAgents.map((a) => a.id));
	return { familyAgents, sessions };
}

/**
 * This project's sessions (the current-app Agents family's), newest first. Project-scoped, never a
 * global list (which would leak other tenants' sessions and undercount; see fetchSessionsForAgents).
 * `includeArchived` defaults to true (the resource-center ledger); the homepage task list passes false
 * so an archived role's tasks leave the list.
 */
export async function fetchProjectSessions(
	prefix = PLAYBOOK_AGENT_NAME_PREFIX,
	options: { includeArchived?: boolean } = {},
): Promise<Session[]> {
	const { sessions } = await fetchProjectAgentsAndSessions(prefix, options);
	return [...sessions].sort((a, b) => toEpoch(b.updated_at) - toEpoch(a.updated_at));
}

// "This project's sessions" = the union of each current-app Agents family's sessions. The backend's only
// session filter is agent_id, so we scope per managed agent id rather than listing globally:
// a global list both leaks unrelated tenant sessions and silently undercounts (a global
// limit-100 page can push this project's sessions out entirely). Each agent is paged to
// exhaustion with a safety cap so a runaway cursor can't loop.
const MAX_SESSION_PAGES = 10;
async function fetchSessionsForAgents(agentIds: string[]): Promise<Session[]> {
	const perAgent = await Promise.all(agentIds.map((agentId) => fetchAgentSessions(agentId)));
	return perAgent.flat();
}

async function fetchAgentSessions(agentId: string): Promise<Session[]> {
	const all: Session[] = [];
	let pageToken: string | undefined;
	for (let i = 0; i < MAX_SESSION_PAGES; i++) {
		const res = await getApiSessions({ query: { limit: 100, agentId, pageToken } });
		if (res.error) throw new Error(formatApiErrorMessage(res.error, "读取任务列表失败"));
		all.push(...(res.data?.data ?? []));
		const next = res.data?.next_page_token ?? undefined;
		if (!next) break;
		pageToken = next;
	}
	return all;
}

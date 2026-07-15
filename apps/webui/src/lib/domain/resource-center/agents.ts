import {
	getPlaybookDisplayName,
	listPlaybooks,
	PLAYBOOK_METADATA_KEY,
	resolveSeedPlaybook,
} from "@openagentpack/playbooks";
import type { CloudAgent, CloudEnvironment, CloudVault, Session } from "@openagentpack/sdk";
import type { UploadedFile } from "../file-api";
import type { SkillSummary } from "../skill-api";
import { identityOf, modelId } from "./identity";
import { deriveReferencedMcpServers } from "./mcp";
import { deriveEnvironments, deriveFiles, deriveReferencedSkills, deriveSkills, deriveVaults } from "./resources";
import { toEpoch } from "./shared";
import type { MissingPlaybookRow, ResourceAgentRow, ResourceCenterView } from "./types";

export function deriveResourceCenter(
	cloudAgents: CloudAgent[],
	sessions: Session[],
	nameSourceAgents: CloudAgent[] = cloudAgents,
	environments: CloudEnvironment[] = [],
	vaults: CloudVault[] = [],
	files: UploadedFile[] = [],
	skills: SkillSummary[] = [],
	officialSkills: SkillSummary[] = [],
): ResourceCenterView {
	const playbooks = listPlaybooks();
	const playbookById = new Map(playbooks.map((p) => [p.id, p]));
	const playbookByAgentName = new Map(playbooks.map((p) => [resolveSeedPlaybook(p.id).agent.name, p]));

	// id → name across the WHOLE family (active + archived) so a session owned by an archived
	// agent still shows its agent's name instead of falling back to a bare short id.
	const agentNameById = new Map(nameSourceAgents.map((a) => [a.id, a.name ?? ""]));
	const annotatedSessions = sessions.map((session) => {
		const id = session.agent?.agent_id;
		if (session.agent && id && !session.agent.name) {
			const name = agentNameById.get(id);
			if (name) return { ...session, agent: { ...session.agent, name } };
		}
		return session;
	});

	// Task counts keyed by the agent id a session is bound to.
	const taskCountByAgentId = new Map<string, number>();
	for (const session of sessions) {
		const id = session.agent?.agent_id;
		if (id) taskCountByAgentId.set(id, (taskCountByAgentId.get(id) ?? 0) + 1);
	}

	// Same display name appearing on >1 cloud agent → duplicate.
	const nameCounts = new Map<string, number>();
	for (const agent of cloudAgents) {
		const name = agent.name ?? "";
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}

	const agents: ResourceAgentRow[] = cloudAgents.map((agent) => {
		const name = agent.name ?? "";
		const identity = identityOf(agent);
		const stampedSlug = agent.metadata?.[PLAYBOOK_METADATA_KEY];
		// Canonical: app_id + playbook_id. Fallback (display only): infer playbook by exact name.
		const inferredPlaybook = playbookByAgentName.get(name);
		const playbook = (stampedSlug ? playbookById.get(stampedSlug) : undefined) ?? inferredPlaybook;
		const playbookInferred = !stampedSlug && Boolean(inferredPlaybook);
		return {
			id: agent.id,
			name,
			description: agent.description ?? undefined,
			model: modelId(agent.model),
			version: agent.version,
			createdAt: agent.created_at,
			updatedAt: agent.updated_at,
			identity,
			playbookSlug: playbook?.id,
			playbookName: playbook ? getPlaybookDisplayName(playbook.id) : undefined,
			playbookInferred,
			duplicate: (nameCounts.get(name) ?? 0) > 1,
			taskCount: taskCountByAgentId.get(agent.id) ?? 0,
			raw: agent,
		};
	});

	// A playbook is "covered" if some cloud agent maps to it (by stamp or name).
	const coveredSlugs = new Set(agents.map((a) => a.playbookSlug).filter((s): s is string => Boolean(s)));
	const missing: MissingPlaybookRow[] = playbooks.flatMap((s) =>
		coveredSlugs.has(s.id)
			? []
			: [{ slug: s.id, name: resolveSeedPlaybook(s.id).agent.name, playbookName: getPlaybookDisplayName(s.id) }],
	);

	const duplicateNames = [...nameCounts.entries()].flatMap(([name, n]) => (n > 1 ? [name] : []));
	const orphanCount = agents.filter((a) => a.identity !== "playbook").length;

	const sortedSessions = [...annotatedSessions].sort((a, b) => toEpoch(b.updated_at) - toEpoch(a.updated_at));
	const { rows: environmentRows, baseId } = deriveEnvironments(environments);
	const { rows: vaultRows, baseVaultId } = deriveVaults(vaults);
	const fileRows = deriveFiles(files);
	const skillRows = deriveSkills(skills);
	const officialSkillRows = deriveSkills(officialSkills);
	const referencedSkills = deriveReferencedSkills(skills, officialSkills);
	const referencedMcpServers = deriveReferencedMcpServers(agents);

	return {
		agents,
		missing,
		metrics: {
			cloudAgentCount: cloudAgents.length,
			playbookCovered: coveredSlugs.size,
			playbookTotal: playbooks.length,
			duplicateGroups: duplicateNames.length,
			orphanCount,
			totalTasks: sessions.length,
			skillCount: skillRows.length,
		},
		duplicateNames,
		sessions: sortedSessions,
		environments: environmentRows,
		baseEnvironmentId: baseId,
		vaults: vaultRows,
		baseVaultId,
		files: fileRows,
		skills: skillRows,
		officialSkills: officialSkillRows,
		referencedSkills,
		referencedMcpServers,
	};
}

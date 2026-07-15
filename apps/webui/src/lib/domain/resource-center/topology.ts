import { getPlaybookDisplayName, listPlaybooks, resolveSeedPlaybook } from "@openagentpack/playbooks";
import { readMcpServerNames } from "./mcp";
import type {
	PlaybookAgentRelationStatus,
	PlaybookDependencyStatus,
	PlaybookMcpDependency,
	PlaybookMcpStatus,
	PlaybookResourceRow,
	PlaybookSkillDependency,
	ReferencedMcpRow,
	ReferencedSkillRow,
	ResourceAgentRow,
	ResourceCenterView,
	ResourceTopologyView,
} from "./types";

export function deriveResourceTopology(view: ResourceCenterView): ResourceTopologyView {
	const playbooks = listPlaybooks().map((playbook) =>
		derivePlaybookResourceRow(playbook.id, getPlaybookDisplayName(playbook.id), view),
	);
	const readyPlaybooks = playbooks.filter((pb) => pb.status === "ready").length;
	const missingAgentPlaybooks = playbooks.filter((pb) => pb.status === "missing-agent").length;
	const skillProblemPlaybooks = playbooks.filter((pb) => pb.skills.status === "problem").length;
	const mcpDriftPlaybooks = playbooks.filter((pb) => pb.mcp.status === "drifted").length;
	return {
		summary: {
			playbookTotal: playbooks.length,
			readyPlaybooks,
			problemPlaybooks: playbooks.length - readyPlaybooks,
			missingAgentPlaybooks,
			skillProblemPlaybooks,
			mcpDriftPlaybooks,
			totalSessions: view.sessions.length,
		},
		playbooks,
		library: {
			files: view.files.length,
			customSkills: view.skills.length,
			officialSkills: view.officialSkills.length,
			referencedSkills: view.referencedSkills.length,
			referencedMcpServers: view.referencedMcpServers.length,
		},
		runtime: {
			hasBaseEnvironment: Boolean(view.baseEnvironmentId),
			hasBaseVault: Boolean(view.baseVaultId),
		},
	};
}

function derivePlaybookResourceRow(
	playbookId: string,
	playbookName: string,
	view: ResourceCenterView,
): PlaybookResourceRow {
	const agentName = resolveSeedPlaybook(playbookId).agent.name;
	const agents = view.agents.filter((agent) => agent.playbookSlug === playbookId);
	const primary = agents.find((agent) => agent.identity === "playbook") ?? agents[0];
	const agent = derivePlaybookAgentRelation(agents, primary);
	const sessions = derivePlaybookSessions(agents, view.sessions);
	const skills = derivePlaybookSkills(playbookId, view.referencedSkills);
	const mcp = derivePlaybookMcp(playbookId, agents, view.referencedMcpServers);
	const { status, statusLabel, issues } = derivePlaybookStatus(agent.status, skills, mcp);
	return {
		playbookId,
		playbookName,
		agentName,
		agent,
		sessions,
		skills,
		mcp,
		status,
		statusLabel,
		issues,
	};
}

function derivePlaybookAgentRelation(
	agents: ResourceAgentRow[],
	primary?: ResourceAgentRow,
): PlaybookResourceRow["agent"] {
	if (agents.length === 0) return { status: "missing", label: "缺失", agents };
	if (agents.length > 1) return { status: "duplicate", label: `重复 ${agents.length}`, agents, primary };
	if (primary?.identity !== "playbook") return { status: "drifted", label: "身份漂移", agents, primary };
	return { status: "ready", label: primary.version ? `正常 v${primary.version}` : "正常", agents, primary };
}

function derivePlaybookSessions(
	agents: ResourceAgentRow[],
	sessions: ResourceCenterView["sessions"],
): PlaybookResourceRow["sessions"] {
	const agentIds = new Set(agents.map((agent) => agent.id));
	const owned = sessions.filter((session) => {
		const id = session.agent?.agent_id;
		return Boolean(id && agentIds.has(id));
	});
	const latest = owned[0];
	return {
		count: owned.length,
		latest,
		label: latest?.status ? `${owned.length} · ${latest.status}` : String(owned.length),
	};
}

function derivePlaybookSkills(
	playbookId: string,
	referencedSkills: ReferencedSkillRow[],
): PlaybookResourceRow["skills"] {
	const rows: PlaybookSkillDependency[] = referencedSkills.flatMap((skill) =>
		skill.declaredBy.includes(playbookId)
			? [
					{
						key: skill.key,
						name: skill.name,
						type: skill.type,
						status: skill.status,
						providerCode: skill.providerCode,
						latestVersion: skill.latestVersion,
					},
				]
			: [],
	);
	const declared = rows.length;
	const available = rows.filter((skill) => skill.status === "active" || skill.status === "declared").length;
	const pending = rows.filter((skill) => skill.status === "checking").length;
	const problematic = declared - available - pending;
	const status: PlaybookDependencyStatus =
		declared === 0 ? "none" : problematic > 0 ? "problem" : pending > 0 ? "pending" : "ready";
	return {
		status,
		declared,
		available,
		pending,
		problematic,
		label: dependencyLabel(declared, available, pending, problematic),
		rows,
	};
}

function derivePlaybookMcp(
	playbookId: string,
	agents: ResourceAgentRow[],
	referencedMcpServers: ReferencedMcpRow[],
): PlaybookResourceRow["mcp"] {
	const rows: PlaybookMcpDependency[] = referencedMcpServers.flatMap((server) => {
		if (!server.declaredBy.includes(playbookId)) return [];
		const attachedCount = agents.filter((agent) => readMcpServerNames(agent.raw.mcp_servers).has(server.name)).length;
		const missingCount = Math.max(agents.length - attachedCount, 0);
		return [
			{
				key: server.key,
				name: server.name,
				type: server.type,
				status: agents.length === 0 ? "pending" : missingCount > 0 ? "missing" : "attached",
				attachedCount,
				missingCount,
			},
		];
	});
	const declared = rows.length;
	const attached = rows.filter((row) => row.status === "attached").length;
	const missing = rows.filter((row) => row.status === "missing").length;
	const status: PlaybookMcpStatus =
		declared === 0 ? "none" : agents.length === 0 ? "pending" : missing > 0 ? "drifted" : "ready";
	return {
		status,
		declared,
		attached,
		missing,
		label: declared === 0 ? "无" : agents.length === 0 ? `${declared} 待创建` : `${attached}/${declared}`,
		rows,
	};
}

function derivePlaybookStatus(
	agentStatus: PlaybookAgentRelationStatus,
	skills: PlaybookResourceRow["skills"],
	mcp: PlaybookResourceRow["mcp"],
): Pick<PlaybookResourceRow, "status" | "statusLabel" | "issues"> {
	const issues: string[] = [];
	if (agentStatus === "missing") issues.push("缺失 Agent");
	if (agentStatus === "duplicate") issues.push("重复 Agent");
	if (agentStatus === "drifted") issues.push("身份戳漂移");
	if (skills.status === "problem") issues.push("Skill 缺失");
	if (skills.status === "pending") issues.push("Skill 扫描中");
	if (mcp.status === "drifted") issues.push("MCP 挂载漂移");

	if (agentStatus === "missing") return { status: "missing-agent", statusLabel: "待初始化", issues };
	if (agentStatus === "duplicate" || agentStatus === "drifted" || mcp.status === "drifted") {
		return { status: "drifted", statusLabel: "有漂移", issues };
	}
	if (skills.status === "problem" || skills.status === "pending") {
		return { status: "degraded", statusLabel: "依赖异常", issues };
	}
	return { status: "ready", statusLabel: "可运行", issues };
}

function dependencyLabel(declared: number, available: number, pending: number, problematic: number): string {
	if (declared === 0) return "无";
	if (problematic > 0) return `${available}/${declared} 缺失`;
	if (pending > 0) return `${available}/${declared} 扫描中`;
	return `${available}/${declared}`;
}

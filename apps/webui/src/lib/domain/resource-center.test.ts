import { describe, expect, test } from "bun:test";
import {
	getPlaybookAppId,
	listPlaybooks,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	resolveSeedPlaybook,
} from "@openagentpack/playbooks";
import type { CloudAgent, CloudEnvironment, Session } from "@openagentpack/sdk";
import type { UploadedFile } from "./file-api";
import {
	deriveEnvironments,
	deriveFiles,
	deriveReferencedMcpServers,
	deriveReferencedSkills,
	deriveResourceCenter,
	deriveResourceTopology,
} from "./resource-center";

const playbooks = listPlaybooks();
const [playbook0, playbook1, , playbook3] = playbooks;

function agentName(playbookId: string): string {
	return resolveSeedPlaybook(playbookId).agent.name;
}

function cloudAgent(over: Partial<CloudAgent> & { id: string }): CloudAgent {
	return { archived_at: null, ...over } as CloudAgent;
}

function sessionFor(agentId: string): Session {
	return { agent: { agent_id: agentId } } as unknown as Session;
}

function sessionAt(sessionId: string, agentId: string, updatedAt: string): Session {
	return { session_id: sessionId, agent: { agent_id: agentId }, updated_at: updatedAt } as unknown as Session;
}

function playbookMetadata(playbookId: string): Record<string, string> {
	return { [PLAYBOOK_APP_METADATA_KEY]: getPlaybookAppId(), [PLAYBOOK_METADATA_KEY]: playbookId };
}

function cloudEnv(over: Partial<CloudEnvironment> & { id: string }): CloudEnvironment {
	return { archived_at: null, ...over } as CloudEnvironment;
}

describe("deriveResourceCenter", () => {
	test("annotates identity, playbook mapping, duplicates, task counts and missing playbooks", () => {
		const stamped = cloudAgent({
			id: "agt_playbook",
			name: agentName(playbook0.id),
			metadata: playbookMetadata(playbook0.id),
		});
		const cmaOrphan = cloudAgent({
			id: "agt_cma",
			name: agentName(playbook1.id),
			metadata: { "agents.project": "p", "agents.resource": "r" },
		});
		const dupA = cloudAgent({ id: "agt_dup_a", name: "Agents/dup" });
		const dupB = cloudAgent({ id: "agt_dup_b", name: "Agents/dup" });

		const view = deriveResourceCenter(
			[stamped, cmaOrphan, dupA, dupB],
			[sessionFor("agt_playbook"), sessionFor("agt_playbook"), sessionFor("agt_cma")],
		);

		const byId = new Map(view.agents.map((a) => [a.id, a]));

		// Canonical app_id + playbook_id stamp resolves the playbook directly (not inferred).
		expect(byId.get("agt_playbook")?.identity).toBe("playbook");
		expect(byId.get("agt_playbook")?.playbookSlug).toBe(playbook0.id);
		expect(byId.get("agt_playbook")?.playbookInferred).toBe(false);
		expect(byId.get("agt_playbook")?.taskCount).toBe(2);

		// agents.* orphan: no app/playbook stamp → identity "agents", playbook inferred by exact name.
		expect(byId.get("agt_cma")?.identity).toBe("agents");
		expect(byId.get("agt_cma")?.playbookSlug).toBe(playbook1.id);
		expect(byId.get("agt_cma")?.playbookInferred).toBe(true);
		expect(byId.get("agt_cma")?.taskCount).toBe(1);

		// Same display name across two agents → both flagged duplicate.
		expect(byId.get("agt_dup_a")?.duplicate).toBe(true);
		expect(byId.get("agt_dup_b")?.duplicate).toBe(true);
		expect(byId.get("agt_dup_a")?.identity).toBe("none");
		expect(view.duplicateNames).toContain("Agents/dup");

		// Orphans = every agent without a current-app playbook stamp (agents + 2 dups).
		expect(view.metrics.orphanCount).toBe(3);
		expect(view.metrics.duplicateGroups).toBe(1);
		expect(view.metrics.cloudAgentCount).toBe(4);
		expect(view.metrics.totalTasks).toBe(3);

		// Two playbooks covered (by stamp + by name); the rest surface as missing.
		expect(view.metrics.playbookCovered).toBe(2);
		expect(view.metrics.playbookTotal).toBe(playbooks.length);
		// Playbook templates currently declare one shared official skill and no MCP servers.
		expect(view.referencedSkills).toHaveLength(1);
		expect(view.referencedMcpServers).toHaveLength(0);
		const missingSlugs = view.missing.map((m) => m.slug);
		expect(missingSlugs).not.toContain(playbook0.id);
		expect(missingSlugs).not.toContain(playbook1.id);
		expect(view.missing).toHaveLength(playbooks.length - 2);
	});

	test("exposes the project's sessions, newest first", () => {
		const stamped = cloudAgent({
			id: "agt_playbook",
			name: agentName(playbook0.id),
			metadata: playbookMetadata(playbook0.id),
		});

		const view = deriveResourceCenter(
			[stamped],
			[
				sessionAt("s_old", "agt_playbook", "2026-06-20T00:00:00Z"),
				sessionAt("s_new", "agt_playbook", "2026-06-26T00:00:00Z"),
				sessionAt("s_mid", "agt_playbook", "2026-06-23T00:00:00Z"),
			],
		);

		expect(view.sessions.map((s) => s.session_id)).toEqual(["s_new", "s_mid", "s_old"]);
		expect(view.metrics.totalTasks).toBe(3);
	});

	test("keeps sessions of archived agents and annotates their agent name", () => {
		// Archive is a soft-delete: the agent is excluded from the active table, but its
		// sessions must remain visible. The full family (incl. archived) feeds session
		// scoping + name annotation via the third arg, while the table is built from the
		// active-only first arg.
		const archived = cloudAgent({
			id: "agt_archived",
			name: agentName(playbook0.id),
			metadata: playbookMetadata(playbook0.id),
			archived_at: "2026-06-26T09:46:00Z",
		});
		const session = sessionAt("s_arch", "agt_archived", "2026-06-26T09:45:00Z");

		const view = deriveResourceCenter([], [session], [archived]);

		// Table is active-only → empty; the archived agent's session still shows.
		expect(view.agents).toHaveLength(0);
		expect(view.sessions.map((s) => s.session_id)).toEqual(["s_arch"]);
		// Name annotated from the full-family source even though the agent isn't in the table.
		expect(view.sessions[0]?.agent?.name).toBe(agentName(playbook0.id));
		expect(view.metrics.totalTasks).toBe(1);
	});
});

describe("deriveEnvironments", () => {
	test("returns only the managed base (project-scoped), excludes foreign org envs, reads config defensively", () => {
		const base = cloudEnv({
			id: "env_base",
			name: "Agents/base",
			metadata: { "agents.base": "true" },
			updated_at: "2026-06-20T00:00:00Z",
			config: { type: "cloud", networking: { type: "unrestricted" }, packages: { npm: ["bailian-cli"] } },
			version: 3,
			scope: "organization",
		});
		// Foreign org env — created outside this project; must never appear in the resource center.
		const foreign = cloudEnv({
			id: "env_foreign",
			name: "生产环境",
			updated_at: "2026-06-26T00:00:00Z",
			config: { type: "cloud" },
		});

		const { rows, baseId } = deriveEnvironments([foreign, base]);

		expect(baseId).toBe("env_base");
		// Only the project's base is listed; the foreign env is excluded entirely.
		expect(rows.map((r) => r.id)).toEqual(["env_base"]);

		const baseRow = rows[0];
		expect(baseRow?.isBase).toBe(true);
		expect(baseRow?.networking).toBe("unrestricted");
		expect(baseRow?.packages).toEqual(["bailian-cli"]);
		expect(baseRow?.version).toBe(3);
	});

	test("a name match WITHOUT the stamp is foreign — nothing is shown", () => {
		const lookalike = cloudEnv({ id: "env_x", name: "Agents/base" }); // no agents.base stamp
		const { rows, baseId } = deriveEnvironments([lookalike]);
		expect(baseId).toBeUndefined();
		expect(rows).toHaveLength(0);
	});
});

describe("deriveFiles", () => {
	function file(over: Partial<UploadedFile> & { id: string; filename: string }): UploadedFile {
		return { mime_type: "text/plain", size_bytes: 0, ...over } as UploadedFile;
	}

	test("keeps only Agents__-prefixed files, strips the prefix for display, newest first", () => {
		const rows = deriveFiles([
			file({ id: "f_old", filename: "Agents__old.txt", created_at: "2026-06-20T00:00:00Z" }),
			file({ id: "f_foreign", filename: "someone-else.pdf", created_at: "2026-06-26T00:00:00Z" }),
			file({ id: "f_new", filename: "Agents__new.txt", created_at: "2026-06-25T00:00:00Z" }),
		]);

		// Foreign (unprefixed) file excluded; project files newest first; display name stripped.
		expect(rows.map((r) => r.id)).toEqual(["f_new", "f_old"]);
		expect(rows.map((r) => r.name)).toEqual(["new.txt", "old.txt"]);
		// Raw filename kept intact for keyed ops.
		expect(rows[0]?.filename).toBe("Agents__new.txt");
	});

	test("carries through status/available/mime/size", () => {
		const [row] = deriveFiles([
			file({
				id: "f1",
				filename: "Agents__a.png",
				mime_type: "image/png",
				size_bytes: 123,
				status: "available",
				available: true,
			}),
		]);
		expect(row?.mimeType).toBe("image/png");
		expect(row?.sizeBytes).toBe(123);
		expect(row?.status).toBe("available");
		expect(row?.available).toBe(true);
	});
});

describe("referenced resources", () => {
	test("returns declared official skill even when custom skill catalog is unrelated", () => {
		// Playbook templates declare a shared official skill. Passing an
		// unrelated custom-skill catalog should not affect referenced official rows.
		const rows = deriveReferencedSkills([
			{
				id: "skill_code_1",
				name: "bailian-cli-skill",
				source: "custom",
				status: "active",
				latest_version: "1.0",
			},
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("skill_N2U0MDAwYWM2NDQ0NGFkNjljMz");
		expect(rows[0]?.type).toBe("official");
		expect(rows[0]?.status).toBe("declared");
	});

	test("derives MCP extra status from agents mounting undeclared MCP servers", () => {
		// No playbooks currently declare MCP servers, so any mcp_servers on cloud agents
		// are classified as "extra" (undeclared but mounted).
		const playbookA = playbook1.id;
		const playbookB = playbooks[2].id;
		const attached = cloudAgent({
			id: "agt_mcp_attached",
			name: agentName(playbookA),
			metadata: playbookMetadata(playbookA),
			mcp_servers: [{ name: "WebSearch" }],
		});
		const missing = cloudAgent({
			id: "agt_mcp_missing",
			name: agentName(playbookB),
			metadata: playbookMetadata(playbookB),
			mcp_servers: [{ name: "UnexpectedMcp" }],
		});
		const view = deriveResourceCenter([attached, missing], []);
		const rows = deriveReferencedMcpServers(view.agents);
		const byName = new Map(rows.map((row) => [row.name, row]));

		expect(byName.get("WebSearch")?.status).toBe("extra");
		expect(byName.get("WebSearch")?.attachedAgents).toEqual([agentName(playbookA)]);
		expect(byName.get("WebSearch")?.declaredBy).toEqual([]);
		expect(byName.get("UnexpectedMcp")?.status).toBe("extra");
		expect(byName.get("UnexpectedMcp")?.declaredBy).toEqual([]);
	});
});

describe("deriveResourceTopology", () => {
	test("summarizes a ready playbook through agent, sessions, and MCP (official skill declared)", () => {
		// playbook3 (researcher) declares an official skill; without official catalog hydration the
		// dependency stays "declared" and still counts as available (ready).
		const stamped = cloudAgent({
			id: "agt_ready",
			name: agentName(playbook3.id),
			metadata: playbookMetadata(playbook3.id),
			version: 3,
			mcp_servers: [{ name: "WebSearch" }],
		});
		const view = deriveResourceCenter(
			[stamped],
			[sessionAt("s_ready", "agt_ready", "2026-06-26T00:00:00Z")],
			[stamped],
		);

		const playbook = deriveResourceTopology(view).playbooks.find((row) => row.playbookId === playbook3.id);

		expect(playbook?.agent.status).toBe("ready");
		expect(playbook?.agent.label).toBe("正常 v3");
		expect(playbook?.sessions.count).toBe(1);
		expect(playbook?.skills.status).toBe("ready");
		expect(playbook?.mcp.status).toBe("none");
		expect(playbook?.status).toBe("ready");
	});

	test("marks playbooks with no mapped cloud agent as pending initialization", () => {
		const view = deriveResourceCenter([], []);
		const playbook = deriveResourceTopology(view).playbooks.find((row) => row.playbookId === playbook0.id);

		expect(playbook?.agent.status).toBe("missing");
		expect(playbook?.status).toBe("missing-agent");
		expect(playbook?.statusLabel).toBe("待初始化");
	});

	test("surfaces identity drift and duplicate agents before dependency details", () => {
		const drifted = cloudAgent({
			id: "agt_drifted",
			name: agentName(playbook0.id),
			metadata: { "agents.project": "p", "agents.resource": "r" },
		});
		const dupA = cloudAgent({
			id: "agt_dup_a",
			name: agentName(playbook1.id),
			metadata: playbookMetadata(playbook1.id),
		});
		const dupB = cloudAgent({
			id: "agt_dup_b",
			name: agentName(playbook1.id),
			metadata: playbookMetadata(playbook1.id),
		});
		const view = deriveResourceCenter([drifted, dupA, dupB], []);
		const topology = deriveResourceTopology(view);

		const driftedPlaybook = topology.playbooks.find((row) => row.playbookId === playbook0.id);
		const duplicatePlaybook = topology.playbooks.find((row) => row.playbookId === playbook1.id);

		expect(driftedPlaybook?.agent.status).toBe("drifted");
		expect(driftedPlaybook?.status).toBe("drifted");
		expect(driftedPlaybook?.issues).toContain("身份戳漂移");
		expect(duplicatePlaybook?.agent.status).toBe("duplicate");
		expect(duplicatePlaybook?.agent.label).toBe("重复 2");
		expect(duplicatePlaybook?.issues).toContain("重复 Agent");
	});

	test("no MCP declared → mcp status is none regardless of mounted servers", () => {
		// No playbooks declare MCP, so an agent with empty mcp_servers still has mcp status "none".
		// playbook3 (researcher) still declares an official skill.
		const stamped = cloudAgent({
			id: "agt_missing_deps",
			name: agentName(playbook3.id),
			metadata: playbookMetadata(playbook3.id),
			mcp_servers: [],
		});
		const view = deriveResourceCenter([stamped], []);
		const playbook = deriveResourceTopology(view).playbooks.find((row) => row.playbookId === playbook3.id);

		// Skills are declared as official and treated as available ("declared"), MCP still none.
		expect(playbook?.skills.status).toBe("ready");
		expect(playbook?.mcp.status).toBe("none");
		expect(playbook?.issues).not.toContain("MCP 挂载漂移");
		expect(playbook?.issues).not.toContain("Skill 缺失");
	});
});

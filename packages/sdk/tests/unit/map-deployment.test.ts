import { describe, expect, test } from "bun:test";
import { mapDeploymentToSession as mapBailianDeploymentToSession } from "../../src/internal/providers/bailian/mapper.ts";
import { mapDeployment } from "../../src/internal/providers/claude/mapper.ts";
import type { ResolvedDeploymentRefs } from "../../src/internal/providers/interface.ts";
import {
	mapDeploymentToSession,
	mapDeployment as mapQoderDeployment,
} from "../../src/internal/providers/qoder/mapper.ts";
import type { DeploymentDecl } from "../../src/internal/types/config.ts";

function fullRefs(): ResolvedDeploymentRefs {
	return {
		agent_id: "agent_123",
		agent_version: 3,
		environment_id: "env_456",
		tunnel_id: "tnl_789",
		vault_ids: ["vault_a"],
		memory_store_ids: { notes: "ms_1", archive: "ms_2" },
	};
}

function minimalRefs(): ResolvedDeploymentRefs {
	return {
		agent_id: "agent_min",
		environment_id: "env_min",
		vault_ids: [],
		memory_store_ids: {},
	};
}

describe("Claude mapDeployment", () => {
	test("full decl produces correct body", () => {
		const decl: DeploymentDecl = {
			agent: "researcher",
			agent_version: 3,
			description: "Daily report",
			schedule: { expression: "0 9 * * *", timezone: "UTC" },
			initial_events: [
				{ type: "user.message", content: "Run the daily report" },
				{ type: "system.message", content: "You are punctual" },
				{
					type: "user.define_outcome",
					description: "Grade",
					rubric: "Must include charts",
					max_iterations: 5,
				},
			],
			memory_stores: ["notes"],
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/acme/repo",
					checkout: { branch: "main" },
					mount_path: "/repo",
				},
				{
					type: "memory_store",
					memory_store: "archive",
					access: "read_only",
					instructions: "ref only",
				},
			],
		};

		const body = mapDeployment("daily-report", decl, fullRefs(), "myproj") as Record<string, unknown>;

		expect(body.name).toBe("daily-report");
		expect(body.agent).toEqual({ id: "agent_123", type: "agent", version: 3 });
		expect(body.environment_id).toBe("env_456");
		expect(body.vault_ids).toEqual(["vault_a"]);
		expect(body.initial_events).toEqual([
			{ type: "user.message", content: [{ type: "text", text: "Run the daily report" }] },
			{ type: "system.message", content: [{ type: "text", text: "You are punctual" }] },
			{
				type: "user.define_outcome",
				description: "Grade",
				rubric: { type: "text", content: "Must include charts" },
				max_iterations: 5,
			},
		]);
		expect(body.resources).toEqual([
			{
				type: "github_repository",
				url: "https://github.com/acme/repo",
				checkout: { type: "branch", name: "main" },
				mount_path: "/repo",
			},
			{ type: "memory_store", memory_store_id: "ms_2", access: "read_only", instructions: "ref only" },
			{ type: "memory_store", memory_store_id: "ms_1" },
		]);
		expect(body.schedule).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "UTC" });
		expect(body.description).toBe("Daily report");
		expect(body.metadata).toEqual({ "agents.project": "myproj", "agents.resource": "daily-report" });
	});

	test("minimal decl omits optional fields and uses bare agent id", () => {
		const body = mapDeployment("d", { agent: "x", initial_events: [] }, minimalRefs()) as Record<string, unknown>;

		expect(body.agent).toBe("agent_min");
		expect(body.environment_id).toBe("env_min");
		expect(body.initial_events).toEqual([]);
		expect(body.vault_ids).toBeUndefined();
		expect(body.resources).toBeUndefined();
		expect(body.schedule).toBeUndefined();
		expect(body.description).toBeUndefined();
		expect(body.metadata).toBeUndefined();
	});

	test("define_outcome with rubric_file maps to a file rubric", () => {
		const decl: DeploymentDecl = {
			agent: "x",
			initial_events: [{ type: "user.define_outcome", rubric_file: "file_abc" }],
		};
		const body = mapDeployment("d", decl, minimalRefs()) as Record<string, unknown>;
		expect(body.initial_events).toEqual([
			{ type: "user.define_outcome", rubric: { type: "file", file_id: "file_abc" } },
		]);
	});

	test("a source-only file is omitted when no upload map is provided", () => {
		const decl: DeploymentDecl = {
			agent: "x",
			initial_events: [],
			resources: [
				{ type: "file", source: "./local.txt" },
				{ type: "file", file_id: "file_1", mount_path: "/data/x" },
			],
		};
		const body = mapDeployment("d", decl, minimalRefs()) as Record<string, unknown>;
		expect(body.resources).toEqual([{ type: "file", file_id: "file_1", mount_path: "/data/x" }]);
	});

	test("a source-only file resolves to its uploaded file_id when an upload map is provided", () => {
		const decl: DeploymentDecl = {
			agent: "x",
			initial_events: [],
			resources: [
				{ type: "file", source: "./local.txt", mount_path: "/data/local" },
				{ type: "file", file_id: "file_1" },
			],
		};
		const uploaded = new Map([["./local.txt", "file_uploaded"]]);
		const body = mapDeployment("d", decl, minimalRefs(), undefined, uploaded) as Record<string, unknown>;
		expect(body.resources).toEqual([
			{ type: "file", file_id: "file_uploaded", mount_path: "/data/local" },
			{ type: "file", file_id: "file_1" },
		]);
	});
});

describe("Qoder mapDeploymentToSession", () => {
	test("full refs + uploaded files produce a session body", () => {
		const decl: DeploymentDecl = {
			agent: "researcher",
			description: "Daily",
			initial_events: [],
			resources: [
				{ type: "file", source: "./report-template.md", mount_path: "/data/report-template.md" },
				{ type: "file", file_id: "file_2" },
			],
		};
		const body = mapDeploymentToSession(decl, fullRefs(), ["file_1", "file_2"]) as Record<string, unknown>;

		expect(body.agent).toBe("agent_123");
		expect(body.environment_id).toBe("env_456");
		expect(body.tunnel_id).toBe("tnl_789");
		expect(body.title).toBe("Daily");
		expect(body.vault_ids).toEqual(["vault_a"]);
		expect(body.memory_store_ids).toBeUndefined();
		expect(body.resources).toEqual([
			{ type: "memory_store", memory_store_id: "ms_1" },
			{ type: "memory_store", memory_store_id: "ms_2" },
			{ type: "file", file_id: "file_1", mount_path: "/data/report-template.md" },
			{ type: "file", file_id: "file_2" },
		]);
	});

	test("minimal refs omit optional fields and use bare agent id", () => {
		const body = mapDeploymentToSession({ agent: "x", initial_events: [] }, minimalRefs(), []) as Record<
			string,
			unknown
		>;

		expect(body.agent).toBe("agent_min");
		expect(body.environment_id).toBe("env_min");
		expect(body.tunnel_id).toBeUndefined();
		expect(body.title).toBeUndefined();
		expect(body.vault_ids).toBeUndefined();
		expect(body.memory_store_ids).toBeUndefined();
		expect(body.resources).toBeUndefined();
	});
});

describe("Qoder mapDeployment", () => {
	test("full decl produces a native deployment body", () => {
		const decl: DeploymentDecl = {
			agent: "researcher",
			agent_version: 3,
			description: "Daily report",
			schedule: { expression: "0 9 * * *", timezone: "Asia/Shanghai" },
			initial_events: [
				{ type: "user.message", content: "Run the daily report" },
				{ type: "system.message", content: "You are punctual" },
				{
					type: "user.define_outcome",
					description: "Grade",
					rubric: "Must include charts",
					max_iterations: 5,
				},
			],
			memory_stores: ["notes"],
			resources: [
				{ type: "file", source: "./local.txt", mount_path: "/data/local" },
				{
					type: "github_repository",
					url: "https://github.com/acme/repo",
					checkout: { branch: "main" },
					mount_path: "/repo",
				},
				{
					type: "memory_store",
					memory_store: "archive",
					access: "read_only",
					instructions: "ref only",
				},
			],
		};

		const uploaded = new Map([["./local.txt", "file_uploaded"]]);
		const body = mapQoderDeployment("daily-report", decl, fullRefs(), "myproj", uploaded) as Record<string, unknown>;

		expect(body.name).toBe("daily-report");
		expect(body.agent).toEqual({ id: "agent_123", type: "agent", version: 3 });
		expect(body.environment_id).toBe("env_456");
		// Qoder's /deployments API rejects tunnel_id (HTTP 400) — never sent.
		expect(body.tunnel_id).toBeUndefined();
		expect(body.initial_events).toEqual([
			{ type: "user.message", content: [{ type: "text", text: "Run the daily report" }] },
			{ type: "system.message", content: [{ type: "text", text: "You are punctual" }] },
			{
				type: "user.define_outcome",
				description: "Grade",
				rubric: { type: "text", content: "Must include charts" },
				max_iterations: 5,
			},
		]);
		expect(body.resources).toEqual([
			{ type: "file", file_id: "file_uploaded", mount_path: "/data/local" },
			{
				type: "github_repository",
				url: "https://github.com/acme/repo",
				checkout: { type: "branch", name: "main" },
				mount_path: "/repo",
			},
			{ type: "memory_store", memory_store_id: "ms_2", access: "read_only", instructions: "ref only" },
			{ type: "memory_store", memory_store_id: "ms_1" },
		]);
		expect(body.schedule).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" });
		expect(body.vault_ids).toEqual(["vault_a"]);
		expect(body.metadata).toEqual({ "agents.project": "myproj", "agents.resource": "daily-report" });
	});
});

describe("Bailian mapDeploymentToSession", () => {
	test("preserves mount_path for file resources", () => {
		const decl: DeploymentDecl = {
			agent: "researcher",
			description: "Daily",
			initial_events: [],
			resources: [
				{ type: "file", source: "./report-template.md", mount_path: "/workspace/report-template.md" },
				{ type: "file", file_id: "file_existing" },
			],
		};
		const body = mapBailianDeploymentToSession(decl, minimalRefs(), ["file_uploaded", "file_existing"]) as Record<
			string,
			unknown
		>;

		expect(body.resources).toEqual([
			{ type: "file", file_id: "file_uploaded", mount_path: "/workspace/report-template.md" },
			{ type: "file", file_id: "file_existing" },
		]);
	});
});

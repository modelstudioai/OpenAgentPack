import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveAgentRefs } from "../../src/internal/executor/resolver.ts";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { agentToDecl, mapAgent } from "../../src/internal/providers/qoder/mapper.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/qoder/index.ts";

const EXAMPLES = resolve(import.meta.dir, "../../../../examples");
const emptyState: StateFile = { resources: [] };
const firecrawlUrl = `https://mcp.firecrawl.dev/\${FIRECRAWL_API_KEY}/v2/mcp`;

test("qoder bailian-cli example declares runnable core capabilities", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "qoder/bailian-cli/agents.yaml"));
	expect(errors).toEqual([]);

	const agent = config.agents?.["bailian-cli"];
	expect(agent?.tools?.builtin).toEqual([
		"Bash",
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"WebSearch",
		"WebFetch",
		"DeliverArtifacts",
	]);
	expect(agent?.mcp_servers).toEqual([
		{
			name: "Firecrawl",
			type: "http",
			url: firecrawlUrl,
		},
	]);
	expect(agent?.skills).toEqual(["bailian-cli-skill"]);
	expect(agent?.vault).toBeUndefined();

	const stateMgr = StateManager.initialize("/tmp/agents-qoder-bailian-cli-example.json");
	stateMgr.setResource({
		address: { type: "skill", name: "bailian-cli-skill", provider: "qoder" },
		remote_id: "skill_test123",
		content_hash: "abc",
	});
	const refs = resolveAgentRefs("bailian-cli", config, "qoder", stateMgr);
	expect(refs.skill_ids).toEqual([{ type: "custom", skill_id: "skill_test123" }]);

	const body = mapAgent("bailian-cli", agent!, refs) as Record<string, unknown>;
	expect(body.system).toBe(agent!.instructions);
	expect(body.tools).toEqual([
		{
			type: "agent_toolset_20260401",
			configs: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "DeliverArtifacts"].map(
				(name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } }),
			),
		},
	]);
	expect(body.mcp_servers).toEqual([
		{
			name: "Firecrawl",
			type: "http",
			url: firecrawlUrl,
		},
	]);
	expect(body.skills).toEqual([{ type: "custom", skill_id: "skill_test123" }]);

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:environment:bailian-cli",
		"create:skill:bailian-cli-skill",
		"create:agent:bailian-cli",
	]);
});

test("qoder agent mapper preserves declared tool permission policies", () => {
	const body = mapAgent(
		"reader",
		{
			model: "auto",
			instructions: "Read only",
			tools: {
				builtin: ["Read", "Bash"],
				permissions: { Read: "allow", Bash: "ask" },
			},
		},
		{ skill_ids: [], memory_store_ids: [] },
	) as Record<string, unknown>;
	expect(body.tools).toEqual([
		{
			type: "agent_toolset_20260401",
			configs: [
				{ name: "Read", enabled: true, permission_policy: { type: "always_allow" } },
				{ name: "Bash", enabled: true, permission_policy: { type: "always_ask" } },
			],
		},
	]);
	expect(body.skills).toEqual([]);
});

test("qoder permission overrides are case- and separator-insensitive", () => {
	const body = mapAgent(
		"reader",
		{
			model: "auto",
			instructions: "Read only",
			tools: {
				builtin: ["Bash", "web_search"],
				permissions: { bash: "ask", WebSearch: "ask" },
			},
		},
		{ skill_ids: [] },
	) as { tools: Array<{ configs: unknown[] }> };
	expect(body.tools[0]!.configs).toEqual([
		{ name: "Bash", enabled: true, permission_policy: { type: "always_ask" } },
		{ name: "WebSearch", enabled: true, permission_policy: { type: "always_ask" } },
	]);
});

test("qoder sync preserves tool permission policies", () => {
	const decl = agentToDecl({
		model: "auto",
		system: "test",
		tools: [
			{
				type: "agent_toolset_20260401",
				configs: [
					{ name: "Read", enabled: true, permission_policy: { type: "always_allow" } },
					{ name: "Bash", enabled: true, permission_policy: { type: "always_ask" } },
				],
			},
		],
	});
	expect(decl.tools).toEqual({
		builtin: ["read", "bash"],
		permissions: { read: "allow", bash: "ask" },
	});
});

test("qoder managed agent mapper emits the coordinator roster wire format", () => {
	const body = mapAgent(
		"lead",
		{
			model: "auto",
			instructions: "Coordinate.",
			multiagent: { type: "coordinator", agents: ["reviewer", "writer"] },
		},
		{
			skill_ids: [],
			multiagent: {
				type: "coordinator",
				members: [
					{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
					{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
				],
			},
		},
	) as Record<string, unknown>;
	expect(body.multiagent).toEqual({
		type: "coordinator",
		agents: [
			{ type: "agent", id: "agent_reviewer_1" },
			{ type: "agent", id: "agent_writer_1" },
		],
	});
	const tools = body.tools as Array<{ type: string }>;
	expect(tools.filter((tool) => tool.type === "agent_toolset_20260401")).toHaveLength(1);
});

test("qoder create omits multiagent when the declaration has no roster", () => {
	const body = mapAgent(
		"solo",
		{ model: "auto", instructions: "Solo." },
		{ skill_ids: [] },
		undefined,
		"tmp",
		"create",
	) as Record<string, unknown>;
	expect("multiagent" in body).toBe(false);
});

test("qoder update clears a previously set roster with multiagent null", () => {
	const body = mapAgent(
		"solo",
		{ model: "auto", instructions: "Solo." },
		{ skill_ids: [] },
		undefined,
		"tmp",
		"update",
	) as Record<string, unknown>;
	expect(body.multiagent).toBeNull();
});

test("qoder update keeps the roster field when the declaration still declares members", () => {
	const body = mapAgent(
		"lead",
		{
			model: "auto",
			instructions: "Coordinate.",
			multiagent: { type: "coordinator", agents: ["reviewer"] },
		},
		{
			skill_ids: [],
			multiagent: {
				type: "coordinator",
				members: [{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" }],
			},
		},
		undefined,
		"tmp",
		"update",
	) as Record<string, unknown>;
	expect(body.multiagent).toEqual({
		type: "coordinator",
		agents: [{ type: "agent", id: "agent_reviewer_1" }],
	});
});

test("plan creates multiagent members before their coordinator", async () => {
	const config = {
		version: "1",
		providers: { qoder: {} },
		defaults: { provider: "qoder" },
		agents: {
			reviewer: { model: "auto", instructions: "Review." },
			writer: { model: "auto", instructions: "Write." },
			lead: {
				model: "auto",
				instructions: "Coordinate.",
				multiagent: { type: "coordinator" as const, agents: ["reviewer", "writer"] },
			},
		},
	};
	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:agent:reviewer",
		"create:agent:writer",
		"create:agent:lead",
	]);
});

test("qoder multiagent example (managed) plans members before the coordinator", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "qoder/multiagent/agents.yaml"));
	expect(errors).toEqual([]);

	const lead = config.agents?.lead;
	expect(lead?.multiagent).toEqual({
		type: "coordinator",
		agents: ["researcher", "writer", { agent_id: "agent_external_reviewer" }],
	});
	expect(lead?.delivery).toBeUndefined();

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:environment:dev",
		"create:agent:researcher",
		"create:agent:writer",
		"create:agent:lead",
	]);
});

test("qoder multiagent-forward example materializes every agent as a template", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "qoder/multiagent-forward/agents.yaml"));
	expect(errors).toEqual([]);

	for (const agent of Object.values(config.agents ?? {})) {
		expect(agent.delivery?.qoder).toEqual({ type: "forward" });
	}
	expect(config.agents?.lead?.multiagent).toEqual({ type: "coordinator", agents: ["researcher", "writer"] });

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:environment:dev",
		"create:template:researcher",
		"create:template:writer",
		"create:template:lead",
	]);
});

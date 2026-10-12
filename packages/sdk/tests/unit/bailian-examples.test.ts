import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { mapAgent } from "../../src/internal/providers/bailian/mapper.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/bailian/index.ts";

const EXAMPLES = resolve(import.meta.dir, "../../../../examples");
const emptyState: StateFile = { resources: [] };

test("bailian multiagent example plans members before the coordinator", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "bailian/multiagent/agents.yaml"));
	expect(errors).toEqual([]);

	const lead = config.agents?.lead;
	expect(lead?.multiagent).toEqual({
		type: "coordinator",
		agents: ["researcher", "writer", { agent_id: "agent_external_reviewer" }],
	});
	// Children run in parallel on a shared file system — the coordinator's
	// instructions must declare file ownership.
	expect(lead?.instructions).toContain("parallel");
	expect(lead?.instructions).toContain("file system");
	expect(config.agents?.researcher?.instructions).toContain("/work/research/");
	expect(config.agents?.writer?.instructions).toContain("/work/report/");

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:environment:dev",
		"create:agent:researcher",
		"create:agent:writer",
		"create:agent:lead",
	]);
});

test("bailian WebSearch example declares a runnable deployment", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "bailian/with-mcp/agents.yaml"));
	expect(errors).toEqual([]);

	const agent = config.agents?.researcher;
	expect(agent?.mcp_servers).toEqual([{ type: "official", name: "WebSearch" }]);
	expect(agent?.tools?.mcp).toEqual([
		{
			type: "mcp_toolkit",
			mcp_server_name: "WebSearch",
			default_config: { enabled: false },
			configs: [{ name: "bailian_web_search", enabled: true }],
		},
	]);

	const body = mapAgent("researcher", agent!, { skill_ids: [] }) as Record<string, unknown>;
	expect(body.mcp_servers).toEqual([{ type: "official", name: "WebSearch" }]);

	const tools = body.tools as Array<Record<string, unknown>>;
	const mcpTool = tools.find((t) => t.type === "mcp_toolkit");
	expect(mcpTool).toEqual({
		type: "mcp_toolkit",
		mcp_server_name: "WebSearch",
		default_config: { enabled: false },
		configs: [{ name: "bailian_web_search", enabled: true }],
	});

	const deployment = config.deployments?.["web-search-demo"];
	expect(deployment?.agent).toBe("researcher");
	expect(deployment?.initial_events[0]).toMatchObject({
		type: "user.message",
	});
	const firstEvent = deployment?.initial_events[0] as { content: string } | undefined;
	expect(firstEvent?.content).toContain("bailian_web_search");

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual([
		"create:environment:dev",
		"create:agent:researcher",
		"create:deployment:web-search-demo",
	]);
});

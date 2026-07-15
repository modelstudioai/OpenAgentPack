import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveAgentRefs } from "../../src/internal/executor/resolver.ts";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { mapAgent } from "../../src/internal/providers/qoder/mapper.ts";
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
			enabled_tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "DeliverArtifacts"],
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

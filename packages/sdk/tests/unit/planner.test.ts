import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/claude/index.ts";
import "../../src/internal/providers/qoder/index.ts";
import "../../src/internal/providers/bailian/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

const emptyState: StateFile = {
	resources: [],
};

test("creates actions for all resources from empty state", async () => {
	const { config } = await loadConfig(resolve(FIXTURES, "minimal.yaml"));
	const plan = await buildPlan(config, emptyState);

	const creates = plan.actions.filter((a) => a.action === "create");
	// Should create: env(dev) x2 + skill(code-review) x2 + agent(assistant) x2 = 6
	expect(creates.length).toBe(6);
});

test("produces no-op when state matches", async () => {
	const { config } = await loadConfig(resolve(FIXTURES, "minimal.yaml"));

	// First plan to get hashes
	const plan1 = await buildPlan(config, emptyState);
	const creates = plan1.actions.filter((a) => a.action === "create");

	// Simulate state with matching hashes
	const state: StateFile = {
		resources: creates.map((a) => ({
			address: a.address,
			remote_id: `fake_${a.address.name}_${a.address.provider}`,
			content_hash: (a.after as any)?.content_hash ?? "",
		})),
	};

	const plan2 = await buildPlan(config, state);
	const actionable = plan2.actions.filter((a) => a.action !== "no-op");
	expect(actionable.length).toBe(0);
});

test("detects deletes for resources removed from config", async () => {
	const state: StateFile = {
		resources: [
			{
				address: { type: "agent", name: "old-agent", provider: "claude" },
				remote_id: "agent_old",
				content_hash: "old_hash",
			},
		],
	};

	const { config } = await loadConfig(resolve(FIXTURES, "minimal.yaml"));
	const plan = await buildPlan(config, state);

	const deletes = plan.actions.filter((a) => a.action === "delete");
	expect(deletes.length).toBe(1);
	expect(deletes[0]!.address.name).toBe("old-agent");
});

test("external skill references do not create skill resources", async () => {
	const { config } = await loadConfig(resolve(FIXTURES, "external-skill.yaml"));
	const plan = await buildPlan(config, emptyState);

	const creates = plan.actions.filter((a) => a.action === "create");
	expect(creates.map((a) => a.address.type)).toEqual(["agent"]);
	expect(creates[0]!.address.name).toBe("assistant");
});

test("diagnoses Bailian MCP servers without matching tool config", async () => {
	const plan = await buildPlan(
		{
			version: "1",
			providers: { bailian: {} },
			defaults: { provider: "bailian" },
			agents: {
				researcher: {
					model: "qwen3.7-max",
					instructions: "test",
					tools: { builtin: ["read"] },
					mcp_servers: [{ type: "official", name: "WebSearch" }],
				},
			},
		},
		emptyState,
	);

	expect(plan.diagnostics).toContainEqual({
		severity: "error",
		code: "bailian.agent.mcp_toolkit_missing",
		message: "Bailian MCP server 'WebSearch' requires a matching tools.mcp entry.",
		resource: { type: "agent", name: "researcher", provider: "bailian" },
	});
});

test("emits no action for a kind whose provider capability tier is unsupported", async () => {
	// bailian marks memory_store unsupported in its capability matrix; the graph must
	// filter it so no create action reaches the executor's throw-guarded switch.
	const plan = await buildPlan(
		{
			version: "1",
			providers: { bailian: {} },
			defaults: { provider: "bailian" },
			memory_stores: {
				notes: { description: "test store" },
			},
		},
		emptyState,
	);

	expect(plan.actions.some((a) => a.address.type === "memory_store")).toBe(false);
	expect(plan.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "bailian.memory_store.unsupported",
			resource: { type: "memory_store", name: "notes", provider: "bailian" },
		}),
	);
});

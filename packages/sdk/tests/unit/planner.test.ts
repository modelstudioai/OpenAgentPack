import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/claude/index.ts";
import "../../src/internal/providers/qoder/index.ts";
import "../../src/internal/providers/bailian/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

const emptyState: StateFile = {
	resources: [],
};

const memoryConfig: ProjectConfig = {
	version: "1",
	providers: { qoder: {} },
	defaults: { provider: "qoder" },
	memory_stores: { notes: { description: "Project notes" } },
};

async function matchingMemoryState(remoteId: string | null, projectConfig = memoryConfig): Promise<StateFile> {
	const initialPlan = await buildPlan(projectConfig, emptyState);
	const initialAction = initialPlan.actions.find((action) => action.address.type === "memory_store")!;
	const { content_hash } = initialAction.after as { content_hash: string };
	return {
		resources: [{ address: initialAction.address, remote_id: remoteId, content_hash }],
	};
}

test.each([
	null,
	"",
])("plans memory store creation when remote ID is %p even if the config hash matches", async (remoteId) => {
	const plan = await buildPlan(memoryConfig, await matchingMemoryState(remoteId));
	expect(plan.actions).toHaveLength(1);
	expect(plan.actions[0]?.action).toBe("create");
	expect(plan.actions[0]?.address).toEqual({ provider: "qoder", type: "memory_store", name: "notes" });
});

test("keeps a memory store with a recorded remote ID unchanged when the config hash matches", async () => {
	const plan = await buildPlan(memoryConfig, await matchingMemoryState("memstore_tracked"));
	expect(plan.actions).toHaveLength(1);
	expect(plan.actions[0]?.action).toBe("no-op");
});

test.each([
	{ entries: [{ key: "seed.md", content: "Edited initial content" }] },
	{ entries: [{ key: "another.md", content: "Added initial content" }] },
	{ entries: [] },
	{ entries: undefined },
])("does not update an existing store when initialization entries alone change to %p", async (entryChange) => {
	const originalConfig: ProjectConfig = {
		...memoryConfig,
		memory_stores: {
			notes: { description: "Project notes", entries: [{ key: "seed.md", content: "Initial content" }] },
		},
	};
	const state = await matchingMemoryState("memstore_tracked", originalConfig);
	const nextConfig: ProjectConfig = {
		...originalConfig,
		memory_stores: { notes: { ...originalConfig.memory_stores!.notes!, ...entryChange } },
	};
	const plan = await buildPlan(nextConfig, state);
	expect(plan.actions).toHaveLength(1);
	expect(plan.actions[0]?.action).toBe("no-op");
});

test("explicit initialize mode is equivalent to the omitted default", async () => {
	const state = await matchingMemoryState("memstore_tracked");
	const config: ProjectConfig = {
		...memoryConfig,
		memory_stores: { notes: { ...memoryConfig.memory_stores!.notes!, entries_mode: "initialize" } },
	};
	const plan = await buildPlan(config, state);
	expect(plan.actions[0]?.action).toBe("no-op");
});

test("plans an update when explicitly synchronized entry content changes", async () => {
	const originalConfig: ProjectConfig = {
		...memoryConfig,
		memory_stores: {
			notes: {
				description: "Project notes",
				entries_mode: "sync",
				entries: [{ key: "seed.md", content: "Old content" }],
			},
		},
	};
	const state = await matchingMemoryState("memstore_tracked", originalConfig);
	const nextConfig: ProjectConfig = {
		...originalConfig,
		memory_stores: {
			notes: { ...originalConfig.memory_stores!.notes!, entries: [{ key: "seed.md", content: "New content" }] },
		},
	};
	const plan = await buildPlan(nextConfig, state);
	expect(plan.actions[0]?.action).toBe("update");
});

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

test("plans native Bailian Memory Store creation without unsupported diagnostics", async () => {
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

	expect(plan.actions).toContainEqual(
		expect.objectContaining({
			action: "create",
			address: { type: "memory_store", name: "notes", provider: "bailian" },
		}),
	);
	expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "bailian.memory_store.unsupported")).toBe(false);
});

test("emits no action for a kind whose provider capability tier is unsupported", async () => {
	const plan = await buildPlan(
		{
			version: "1",
			providers: { bailian: {} },
			defaults: { provider: "bailian" },
			identities: {
				user: { external_id: "user_456", name: "Test user" },
			},
		},
		emptyState,
	);

	expect(plan.actions.some((action) => action.address.type === "identity")).toBe(false);
	expect(plan.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "bailian.identity.unsupported",
			resource: { type: "identity", name: "user", provider: "bailian" },
		}),
	);
});

import { describe, expect, test } from "bun:test";
import { collectConfigReferences, validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { buildDependencyGraph } from "../../src/internal/graph/dependency.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { toSessionInfo } from "../../src/internal/providers/bailian/adapter.ts";
import { mapSession } from "../../src/internal/providers/bailian/mapper.ts";
import { buildSessionBindings, parseSessionResources } from "../../src/internal/session/session-manager.ts";
import { InMemoryStateManager } from "../../src/internal/state/in-memory-state-manager.ts";
import type { ProjectConfig, SessionResourceDecl } from "../../src/internal/types/config.ts";
import type { ManagedSessionBindings } from "../../src/internal/types/session.ts";
import "../../src/internal/providers/all.ts";

function fixture() {
	const config: ProjectConfig = {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "workspace" } },
		defaults: { provider: "bailian" },
		environments: { dev: { config: { type: "cloud" } } },
		memory_stores: {
			notes: { name: "Shared notes", description: "Notes", metadata: { nested: { enabled: true }, count: 2 } },
			facts: { description: "Facts" },
		},
		agents: {
			assistant: { model: "qwen-plus", instructions: "Help", environment: "dev", memory_stores: ["notes"] },
		},
	};
	const state = InMemoryStateManager.empty();
	for (const resource of [
		{ type: "agent" as const, name: "assistant", remote_id: "agent_assistant" },
		{ type: "environment" as const, name: "dev", remote_id: "env_dev" },
		{ type: "memory_store" as const, name: "notes", remote_id: "memstore_notes" },
		{ type: "memory_store" as const, name: "facts", remote_id: "memstore_facts" },
	]) {
		state.setResource({
			address: { type: resource.type, name: resource.name, provider: "bailian" },
			remote_id: resource.remote_id,
			content_hash: "hash",
		});
	}
	return { config, state };
}

describe("Bailian Session Memory resources", () => {
	test("resolves shorthand names through State and sends resources instead of top-level ids", () => {
		const { config, state } = fixture();
		const bindings = buildSessionBindings("assistant", config, "bailian", state) as ManagedSessionBindings;
		const body = mapSession(bindings) as Record<string, unknown>;

		expect(bindings.memory_store_ids).toEqual(["memstore_notes"]);
		expect(body.resources).toEqual([{ type: "memory_store", memory_store_id: "memstore_notes", access: "read_write" }]);
		expect(body.memory_store_ids).toBeUndefined();
	});

	test("explicit resources override shorthand defaults and deduplicate the same store", () => {
		const { config, state } = fixture();
		config.agents!.assistant!.resources = [
			{ type: "memory_store", memory_store: "notes", access: "read_only", instructions: "Use past decisions" },
		];
		const bindings = buildSessionBindings("assistant", config, "bailian", state) as ManagedSessionBindings;

		expect(bindings.resources).toEqual([
			{
				type: "memory_store",
				memory_store_id: "memstore_notes",
				access: "read_only",
				instructions: "Use past decisions",
			},
		]);
		expect(bindings.memory_store_ids).toEqual(["memstore_notes"]);
	});

	test("CLI resource overrides replace Agent resources while preserving the selected shorthand", () => {
		const { config, state } = fixture();
		config.agents!.assistant!.resources = [{ type: "memory_store", memory_store: "notes", access: "read_only" }];
		const bindings = buildSessionBindings("assistant", config, "bailian", state, {
			memoryStores: ["facts"],
			resources: [{ type: "memory_store", memory_store: "facts", instructions: "Use these facts" }],
		}) as ManagedSessionBindings;

		expect(bindings.resources).toEqual([
			{
				type: "memory_store",
				memory_store_id: "memstore_facts",
				access: "read_write",
				instructions: "Use these facts",
			},
		]);
		expect(bindings.memory_store_ids).toEqual(["memstore_facts"]);
	});

	test("rejects duplicate explicit mounts even when two logical keys point to one id", () => {
		const { config, state } = fixture();
		state.setResource({
			address: { type: "memory_store", name: "facts", provider: "bailian" },
			remote_id: "memstore_notes",
			content_hash: "hash",
		});
		expect(() =>
			buildSessionBindings("assistant", config, "bailian", state, {
				resources: [
					{ type: "memory_store", memory_store: "notes" },
					{ type: "memory_store", memory_store: "facts" },
				],
			}),
		).toThrow(/more than once/);
	});

	test("rejects an unknown or unapplied logical Memory Store", () => {
		const { config, state } = fixture();
		expect(() =>
			buildSessionBindings("assistant", config, "bailian", state, {
				resources: [{ type: "memory_store", memory_store: "unknown" }],
			}),
		).toThrow(/not defined in config/);
		state.removeResource({ type: "memory_store", name: "facts", provider: "bailian" });
		expect(() =>
			buildSessionBindings("assistant", config, "bailian", state, {
				resources: [{ type: "memory_store", memory_store: "facts" }],
			}),
		).toThrow(/not found in state/);
	});

	test.each(["shorthand", "explicit"])("blocks %s mounting until pending initialization completes", (mountKind) => {
		const { config, state } = fixture();
		const address = { type: "memory_store" as const, name: "notes", provider: "bailian" };
		state.setResource({
			...state.getResource(address)!,
			memory_initialization: { pending_entries: [{ path: "/seed.md", content_sha256: "sha" }] },
		});
		const resources: SessionResourceDecl[] | undefined =
			mountKind === "explicit" ? [{ type: "memory_store", memory_store: "notes" }] : undefined;
		expect(() => buildSessionBindings("assistant", config, "bailian", state, { resources })).toThrow(
			/initialization must complete/,
		);
	});

	test("limits the merged mounts to eight distinct stores", () => {
		const { config, state } = fixture();
		const names = Array.from({ length: 9 }, (_, storeIndex) => `store-${storeIndex}`);
		for (const name of names) {
			config.memory_stores![name] = { description: name };
			state.setResource({
				address: { type: "memory_store", name, provider: "bailian" },
				remote_id: `remote-${name}`,
				content_hash: "hash",
			});
		}
		expect(() => buildSessionBindings("assistant", config, "bailian", state, { memoryStores: names })).toThrow(
			/at most 8/,
		);
	});

	test("retains response resources and server mount paths while extracting Memory Store ids", () => {
		const resources = [
			{
				type: "memory_store",
				memory_store_id: "memstore_notes",
				access: "read_only",
				instructions: "Read context",
				mount_path: "/mnt/memory/notes",
			},
			{ type: "file", file_id: "file_context", mount_path: "/mnt/context.md" },
		];
		const session = toSessionInfo({
			id: "session",
			status: "idle",
			agent: { id: "agent_assistant" },
			environment_id: "env_dev",
			resources,
		});
		expect(session.memory_store_ids).toEqual(["memstore_notes"]);
		expect(session.resources).toEqual(resources);
	});
});

describe("Session Memory declaration validation", () => {
	test("preserves Store display name, JSON metadata and Session Memory settings", () => {
		const { config } = fixture();
		config.agents!.assistant!.resources = [
			{ type: "memory_store", memory_store: "notes", access: "read_only", instructions: "Instructions" },
		];
		const parsed = projectConfigSchema.parse(config);
		expect(parsed.memory_stores?.notes).toEqual(config.memory_stores!.notes);
		expect(parsed.agents?.assistant?.resources).toEqual(config.agents!.assistant!.resources);
	});

	test.each([
		{ invalidField: "type", resources: [{ type: "unknown" }] },
		{ invalidField: "logical key", resources: [{ type: "memory_store", memory_store: "" }] },
		{ invalidField: "access", resources: [{ type: "memory_store", memory_store: "notes", access: "write_only" }] },
		{
			invalidField: "instructions",
			resources: [{ type: "memory_store", memory_store: "notes", instructions: "x".repeat(4097) }],
		},
		{
			invalidField: "mount_path",
			resources: [{ type: "memory_store", memory_store: "notes", mount_path: "/mnt/custom" }],
		},
	])("rejects invalid Session resource $invalidField", ({ resources }) => {
		expect(() => parseSessionResources(resources)).toThrow(/Invalid Session resources/);
	});

	test("reports explicit unknown and duplicate references without conflating Store display names", () => {
		const { config } = fixture();
		config.agents!.assistant!.resources = [
			{ type: "memory_store", memory_store: "Shared notes" },
			{ type: "memory_store", memory_store: "notes" },
			{ type: "memory_store", memory_store: "notes" },
		];
		const diagnostics = collectConfigReferences(config);
		expect(diagnostics.filter((diagnostic) => diagnostic.code === "config.agent.memory_store.unknown")).toHaveLength(1);
		expect(diagnostics.filter((diagnostic) => diagnostic.code === "config.agent.memory_store.duplicate")).toHaveLength(
			1,
		);
	});

	test("adds explicit Memory references to the Agent dependency graph", () => {
		const { config } = fixture();
		config.agents!.assistant!.memory_stores = [];
		config.agents!.assistant!.resources = [{ type: "memory_store", memory_store: "facts" }];
		const graph = buildDependencyGraph(config, ["bailian"]);
		expect(graph.edges.get("bailian.agent.assistant")?.has("bailian.memory_store.facts")).toBe(true);
	});

	test.each([
		"legacy",
		"explicit",
		"inherited-legacy",
		"inherited-resource",
	])("rejects effective Deployment Memory mounting via %s", (mountKind) => {
		const { config } = fixture();
		config.deployments = {
			scheduled: { agent: "assistant", initial_events: [{ type: "user.message", content: "go" }] },
		};
		if (mountKind === "legacy") config.deployments.scheduled!.memory_stores = ["facts"];
		if (mountKind === "explicit")
			config.deployments.scheduled!.resources = [{ type: "memory_store", memory_store: "facts" }];
		if (mountKind === "inherited-resource") {
			config.agents!.assistant!.memory_stores = [];
			config.agents!.assistant!.resources = [{ type: "memory_store", memory_store: "notes" }];
		}
		const diagnostics = validateProjectConfig(config);
		expect(
			diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "bailian.deployment.memory_store.unsupported" && diagnostic.severity === "error",
			),
		).toBe(true);
	});
});

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecContext } from "../../src/internal/executor/context.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { ApiError, ConflictError } from "../../src/internal/providers/base-client.ts";
import { DeploymentCreateConflictError } from "../../src/internal/providers/deployment-conflict.ts";
import type { ProviderAdapter, RemoteResource } from "../../src/internal/providers/interface.ts";
import type { IStateManager } from "../../src/internal/state/state-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { MemoryStoreDecl, ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";

function tmpPath(): string {
	return join(tmpdir(), `exec-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const config: ProjectConfig = {
	version: "1",
	providers: { bailian: { api_key: "test", workspace_id: "ws" } },
	defaults: { provider: "bailian" },
	environments: {
		"my-env": {
			description: "Test env",
			config: { type: "cloud" },
		},
	},
};

function createPlan(): ExecutionPlan {
	return {
		actions: [
			{
				action: "create",
				address: { type: "environment", name: "my-env", provider: "bailian" },
				reason: "Resource does not exist in state",
				after: { content_hash: "h" },
				dependencies: [],
			},
		],
		diagnostics: [],
	};
}

function makeCtx(
	provider: ProviderAdapter,
	state: IStateManager = StateManager.initialize(tmpPath()),
	ctxConfig: ProjectConfig = config,
): ExecContext {
	return {
		config: ctxConfig,
		configPath: "/tmp/agents.yaml",
		providers: new Map([["bailian", provider]]),
		state,
	};
}

const existingResource: RemoteResource = { id: "env_existing", type: "environment", version: 3 };

const bailianMemoryConfig: ProjectConfig = {
	version: "1",
	providers: { bailian: { api_key: "test", workspace_id: "ws" } },
	defaults: { provider: "bailian" },
	memory_stores: { notes: { description: "Updated notes" } },
};

const memoryStoreAddress = { type: "memory_store" as const, name: "notes", provider: "bailian" };

function memoryStorePlan(action: "create" | "update"): ExecutionPlan {
	return {
		actions: [
			{
				action,
				address: memoryStoreAddress,
				reason: action === "create" ? "Resource does not exist in state" : "Local config changed",
				after: { content_hash: "new-memory-hash" },
				dependencies: [],
			},
		],
		diagnostics: [],
	};
}

function makeBailianMemoryProvider() {
	const methods = {
		name: "bailian",
		supportsResourceNameLookup: (resourceType: string) => resourceType !== "memory_store",
		findResource: mock(async () => ({ id: "memstore_same_name", type: "memory_store" })),
		createMemoryStore: mock(async (_storeName: string, _declaration: MemoryStoreDecl) => ({
			id: "memstore_new",
			type: "memory_store",
		})),
		deleteMemoryStore: mock(async () => {}),
		updateMemoryStore: mock(async (storeId: string) => ({
			id: storeId,
			type: "memory_store",
			name: "notes",
			description: "Updated notes",
			metadata: {},
			created_at: "",
			updated_at: "",
		})),
		listMemories: mock(async () => ({ data: [], has_more: false })),
		createMemory: mock(async () => ({ id: "mem_seed", type: "memory" })),
		updateMemory: mock(async () => ({ id: "mem_seed", type: "memory" })),
		deleteMemory: mock(async () => {}),
	};
	return { ...methods, provider: methods as unknown as ProviderAdapter };
}

describe("executor conflict-adopt", () => {
	test("Bailian memory store without state creates and records a new id despite a same-name store", async () => {
		const memoryProvider = makeBailianMemoryProvider();
		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(
			memoryStorePlan("create"),
			makeCtx(memoryProvider.provider, state, bailianMemoryConfig),
		);

		expect(result.partial).toBe(false);
		expect(result.results[0]?.status).toBe("success");
		expect(memoryProvider.createMemoryStore).toHaveBeenCalledTimes(1);
		expect(memoryProvider.findResource).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.listMemories).not.toHaveBeenCalled();
		expect(memoryProvider.createMemory).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemory).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)?.remote_id).toBe("memstore_new");
	});

	test("new Bailian memory store checkpoints its id and initializes entries separately", async () => {
		const memoryProvider = makeBailianMemoryProvider();
		const declaration: MemoryStoreDecl = {
			description: "Initial notes",
			entries: [{ key: "seed.md", content: "Initial content" }],
		};
		const memoryConfig: ProjectConfig = { ...bailianMemoryConfig, memory_stores: { notes: declaration } };
		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(memoryStorePlan("create"), makeCtx(memoryProvider.provider, state, memoryConfig));

		expect(result.partial).toBe(false);
		expect(memoryProvider.createMemoryStore).toHaveBeenCalledWith("notes", declaration, undefined);
		expect(memoryProvider.updateMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.listMemories).toHaveBeenCalledTimes(1);
		expect(memoryProvider.createMemory).toHaveBeenCalledWith(
			"memstore_new",
			{ path: "/seed.md", content: "Initial content" },
			undefined,
		);
		expect(memoryProvider.updateMemory).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)?.remote_id).toBe("memstore_new");
		expect(state.getResource(memoryStoreAddress)?.memory_initialization).toBeUndefined();
	});

	test("Bailian memory store with a recorded id reconciles that id without name lookup or creation", async () => {
		const memoryProvider = makeBailianMemoryProvider();
		const state = StateManager.initialize(tmpPath());
		state.setResource({ address: memoryStoreAddress, remote_id: "memstore_tracked", content_hash: "old-memory-hash" });
		const result = await executePlan(
			memoryStorePlan("update"),
			makeCtx(memoryProvider.provider, state, bailianMemoryConfig),
		);

		expect(result.partial).toBe(false);
		expect(result.results[0]?.status).toBe("success");
		expect(memoryProvider.updateMemoryStore).toHaveBeenCalledTimes(1);
		expect(memoryProvider.updateMemoryStore).toHaveBeenCalledWith(
			"memstore_tracked",
			{ name: "notes", description: "Updated notes", metadata: {} },
			undefined,
		);
		expect(memoryProvider.listMemories).not.toHaveBeenCalled();
		expect(memoryProvider.createMemory).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemory).not.toHaveBeenCalled();
		expect(memoryProvider.findResource).not.toHaveBeenCalled();
		expect(memoryProvider.createMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)?.remote_id).toBe("memstore_tracked");
	});

	const initializationOnlyChanges: Array<{ change: string; declaration: MemoryStoreDecl }> = [
		{
			change: "description and metadata change",
			declaration: {
				description: "Updated description",
				metadata: { topic: "updated" },
				entries: [{ key: "seed.md", content: "Original seed" }],
			},
		},
		{
			change: "entry addition",
			declaration: {
				description: "notes",
				entries: [
					{ key: "seed.md", content: "Original seed" },
					{ key: "new.md", content: "Additional seed" },
				],
			},
		},
		{
			change: "entry content change",
			declaration: { description: "notes", entries: [{ key: "seed.md", content: "Changed seed" }] },
		},
		{
			change: "entry removal",
			declaration: { description: "notes", entries: [] },
		},
		{
			change: "explicit initialize mode",
			declaration: {
				description: "notes",
				entries_mode: "initialize",
				entries: [{ key: "seed.md", content: "Changed seed" }],
			},
		},
	];

	test.each(initializationOnlyChanges)("existing memory store preserves its memories after $change", async ({
		declaration,
	}) => {
		const memoryProvider = makeBailianMemoryProvider();
		const memoryConfig: ProjectConfig = { ...bailianMemoryConfig, memory_stores: { notes: declaration } };
		const state = StateManager.initialize(tmpPath());
		state.setResource({ address: memoryStoreAddress, remote_id: "memstore_tracked", content_hash: "old-memory-hash" });
		const result = await executePlan(memoryStorePlan("update"), makeCtx(memoryProvider.provider, state, memoryConfig));

		expect(result.partial).toBe(false);
		expect(memoryProvider.updateMemoryStore).toHaveBeenCalledWith(
			"memstore_tracked",
			{ name: "notes", description: declaration.description, metadata: declaration.metadata ?? {} },
			undefined,
		);
		expect(memoryProvider.listMemories).not.toHaveBeenCalled();
		expect(memoryProvider.createMemory).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemory).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemory).not.toHaveBeenCalled();
		expect(memoryProvider.createMemoryStore).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)?.remote_id).toBe("memstore_tracked");
	});

	test.each([
		null,
		"",
	])("Bailian memory store update without a remote id (%p) creates and records a new store", async (remoteId) => {
		const memoryProvider = makeBailianMemoryProvider();
		const state = StateManager.initialize(tmpPath());
		state.setResource({ address: memoryStoreAddress, remote_id: remoteId, content_hash: "old-memory-hash" });
		const result = await executePlan(
			memoryStorePlan("update"),
			makeCtx(memoryProvider.provider, state, bailianMemoryConfig),
		);

		expect(result.partial).toBe(false);
		expect(result.results[0]?.status).toBe("success");
		expect(memoryProvider.createMemoryStore).toHaveBeenCalledTimes(1);
		expect(memoryProvider.findResource).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)?.remote_id).toBe("memstore_new");
	});

	test("Bailian memory store conflict preserves the original error without adopting a same-name store", async () => {
		const memoryProvider = makeBailianMemoryProvider();
		const originalError = new ConflictError(409, "Memory store creation was rejected", "Bailian API");
		memoryProvider.createMemoryStore.mockRejectedValue(originalError);
		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(
			memoryStorePlan("create"),
			makeCtx(memoryProvider.provider, state, bailianMemoryConfig),
		);

		expect(result.partial).toBe(true);
		expect(result.results[0]?.status).toBe("failed");
		expect(result.results[0]?.error).toBe(originalError);
		expect(memoryProvider.findResource).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
		expect(memoryProvider.listMemories).not.toHaveBeenCalled();
		expect(state.getResource(memoryStoreAddress)).toBeUndefined();
	});

	test("default memory store conflict adoption updates attributes without reading or overwriting memories", async () => {
		const memoryProvider = makeBailianMemoryProvider();
		memoryProvider.createMemoryStore.mockRejectedValue(new ConflictError(409, "exists", "Qoder API"));
		const provider = {
			...memoryProvider.provider,
			name: "qoder",
			supportsResourceNameLookup: () => true,
		} as unknown as ProviderAdapter;
		const memoryConfig: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder" },
			memory_stores: { notes: { description: "Updated notes", entries: [{ key: "seed.md", content: "YAML seed" }] } },
		};
		const address = { ...memoryStoreAddress, provider: "qoder" };
		const plan: ExecutionPlan = {
			actions: [{ ...memoryStorePlan("create").actions[0]!, address }],
			diagnostics: [],
		};
		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(plan, {
			config: memoryConfig,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(result.partial).toBe(false);
		expect(memoryProvider.findResource).toHaveBeenCalledTimes(1);
		expect(memoryProvider.findResource).toHaveBeenCalledWith("memory_store", "notes", undefined, "managed");
		expect(memoryProvider.updateMemoryStore).toHaveBeenCalledWith(
			"memstore_same_name",
			{ name: "notes", description: "Updated notes", metadata: {} },
			"managed",
		);
		expect(memoryProvider.listMemories).not.toHaveBeenCalled();
		expect(memoryProvider.createMemory).not.toHaveBeenCalled();
		expect(memoryProvider.updateMemory).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemory).not.toHaveBeenCalled();
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
		expect(state.getResource(address)?.remote_id).toBe("memstore_same_name");
	});

	test.each([
		true,
		false,
	])("memory store conflict only searches the actual creation name (matching store exists: %p)", async (matchingStoreExists) => {
		const memoryProvider = makeBailianMemoryProvider();
		memoryProvider.createMemoryStore.mockRejectedValue(new ConflictError(409, "exists", "Qoder API"));
		const findResource = mock(async (_resourceType: string, resourceName: string): Promise<RemoteResource | null> => {
			if (resourceName === "Shared notes" && matchingStoreExists) {
				return { id: "memstore_shared", type: "memory_store" };
			}
			if (resourceName === "notes") {
				return { id: "memstore_unrelated", type: "memory_store" };
			}
			return null;
		});
		const provider = {
			...memoryProvider.provider,
			name: "qoder",
			supportsResourceNameLookup: () => true,
			findResource,
		} as unknown as ProviderAdapter;
		const declaration: MemoryStoreDecl = { name: "Shared notes", description: "Updated notes" };
		const memoryConfig: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder" },
			memory_stores: { notes: declaration },
		};
		const address = { ...memoryStoreAddress, provider: "qoder" };
		const plan: ExecutionPlan = {
			actions: [{ ...memoryStorePlan("create").actions[0]!, address }],
			diagnostics: [],
		};
		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(plan, {
			config: memoryConfig,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(memoryProvider.createMemoryStore).toHaveBeenCalledWith("Shared notes", declaration, "managed");
		expect(findResource).toHaveBeenCalledTimes(1);
		expect(findResource).toHaveBeenCalledWith("memory_store", "Shared notes", undefined, "managed");
		expect(result.partial).toBe(!matchingStoreExists);
		if (matchingStoreExists) {
			expect(memoryProvider.updateMemoryStore).toHaveBeenCalledWith(
				"memstore_shared",
				{ name: "Shared notes", description: "Updated notes", metadata: {} },
				"managed",
			);
			expect(state.getResource(address)?.remote_id).toBe("memstore_shared");
		} else {
			expect(memoryProvider.updateMemoryStore).not.toHaveBeenCalled();
			expect(state.getResource(address)).toBeUndefined();
		}
		expect(memoryProvider.deleteMemoryStore).not.toHaveBeenCalled();
	});

	test("explicit sync memory store conflict reconciles seed entries without deleting learned memories", async () => {
		const calls: string[] = [];
		let storeMetadata: Record<string, string> | undefined;
		const provider = {
			name: "qoder",
			findResource: async () => ({ id: "memstore_existing", type: "memory_store" }),
			createMemoryStore: async () => {
				throw new ConflictError(409, "exists", "Qoder API");
			},
			deleteMemoryStore: async () => {
				calls.push("delete-store");
			},
			updateMemoryStore: async (id: string, input: { metadata?: Record<string, string> }) => {
				calls.push(`update-store:${id}`);
				storeMetadata = input.metadata;
				return {
					id,
					type: "memory_store",
					name: "notes",
					description: "notes",
					metadata: {},
					created_at: "",
					updated_at: "",
				};
			},
			listMemories: mock(async () => ({
				data: [
					{
						id: "mem_seed",
						type: "memory",
						memory_store_id: "memstore_existing",
						path: "seed.md",
						content_size_bytes: 3,
						content_sha256: "old",
						metadata: {},
						created_at: "",
						updated_at: "",
					},
					{
						id: "mem_learned",
						type: "memory",
						memory_store_id: "memstore_existing",
						path: "learned.md",
						content_size_bytes: 7,
						content_sha256: "learned",
						metadata: {},
						created_at: "",
						updated_at: "",
					},
				],
				has_more: false,
			})),
			updateMemory: async (_storeId: string, id: string) => {
				calls.push(`update-memory:${id}`);
				return { id, type: "memory" };
			},
			createMemory: async () => ({ id: "mem_new", type: "memory" }),
		} as unknown as ProviderAdapter;
		const memoryConfig: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder" },
			memory_stores: {
				notes: { description: "notes", entries_mode: "sync", entries: [{ key: "seed.md", content: "new" }] },
			},
		};
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "memory_store", name: "notes", provider: "qoder" },
					reason: "missing",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};
		const ctx: ExecContext = {
			config: memoryConfig,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state: StateManager.initialize(tmpPath()),
		};
		const result = await executePlan(plan, ctx);
		expect(result.partial).toBe(false);
		expect(calls).toEqual(["update-store:memstore_existing", "update-memory:mem_seed"]);
		expect(storeMetadata).toEqual({});
		expect(provider.listMemories).toHaveBeenCalledWith(
			"memstore_existing",
			expect.objectContaining({ limit: 100 }),
			"managed",
		);
	});

	test("ConflictError → findResource finds existing → onExisting rebuilds via updateEnvironment", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => existingResource,
			createEnvironment: async () => {
				throw new ConflictError(409, "已存在", "Bailian API");
			},
			updateEnvironment: async (id: string) => {
				calls.push(`updateEnvironment:${id}`);
				return { id, type: "environment", version: 4 };
			},
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(createPlan(), makeCtx(provider, state));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual(["updateEnvironment:env_existing"]);
		const saved = state.getResource({ type: "environment", name: "my-env", provider: "bailian" })!;
		expect(saved.remote_id).toBe("env_existing");
	});

	test("ConflictError → findResource returns null → nameReservedError with actionable guidance", async () => {
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => {
				throw new ConflictError(409, "已存在", "Bailian API");
			},
			updateEnvironment: async () => ({ id: "x", type: "environment" }),
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const result = await executePlan(createPlan(), makeCtx(provider));

		expect(result.partial).toBe(true);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].error?.message).toContain("already exists");
		expect(result.results[0].error?.message).toContain("could not be found remotely to adopt");
		expect(result.results[0].error?.message).toContain("Wait for the provider to release the name");
	});

	test("non-conflict ApiError(500) rethrows without attempting adopt", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => {
				calls.push("findResource");
				return existingResource;
			},
			createEnvironment: async () => {
				throw new ApiError(500, "internal server error", "Bailian API");
			},
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				return { id: "x", type: "environment" };
			},
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const result = await executePlan(createPlan(), makeCtx(provider));

		expect(result.partial).toBe(true);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].error?.message).toContain("500");
		expect(calls).toEqual([]);
	});

	test("deployment conflict adoption reuses files uploaded by create", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "exec-deployment-conflict-"));
		writeFileSync(join(projectDir, "report-template.md"), "# template");
		const deploymentConfig: ProjectConfig = {
			version: "1",
			providers: { bailian: { api_key: "test", workspace_id: "ws" } },
			defaults: { provider: "bailian" },
			environments: { dev: { config: { type: "cloud" } } },
			agents: {
				reporter: {
					model: "qwen-plus",
					instructions: "Generate reports",
					environment: "dev",
				},
			},
			deployments: {
				"daily-report": {
					agent: "reporter",
					initial_events: [{ type: "user.message", content: "go" }],
					resources: [{ type: "file", source: "report-template.md" }],
				},
			},
		};
		const calls: string[] = [];
		let findCalls = 0;
		const provider = {
			name: "bailian",
			findResource: async (type: string, name: string) => {
				calls.push(`find:${type}.${name}`);
				findCalls += 1;
				return findCalls === 1 ? null : { id: "deployment_existing", type: "deployment" };
			},
			createDeployment: async () => {
				calls.push("create-and-upload:file_uploaded_once");
				throw new DeploymentCreateConflictError(
					new ConflictError(409, "exists", "Bailian API"),
					new Map([["report-template.md", "file_uploaded_once"]]),
				);
			},
			updateDeployment: async (
				id: string,
				_name: unknown,
				_decl: unknown,
				_refs: unknown,
				_basePath: unknown,
				preparedFiles?: ReadonlyMap<string, string>,
			) => {
				calls.push(`update-and-reuse:${id}:${preparedFiles?.get("report-template.md") ?? "missing"}`);
				return { id, type: "deployment" };
			},
		} as unknown as ProviderAdapter;
		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "environment", name: "dev", provider: "bailian" },
			remote_id: "environment_existing",
			content_hash: "h",
		});
		state.setResource({
			address: { type: "agent", name: "reporter", provider: "bailian" },
			remote_id: "agent_existing",
			content_hash: "h",
		});
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "deployment", name: "daily-report", provider: "bailian" },
					reason: "missing",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};
		const ctx: ExecContext = {
			config: deploymentConfig,
			configPath: join(projectDir, "agents.yaml"),
			providers: new Map([["bailian", provider]]),
			state,
		};

		const result = await executePlan(plan, ctx);

		expect(result.partial).toBe(false);
		expect(calls).toEqual([
			"find:deployment.daily-report",
			"create-and-upload:file_uploaded_once",
			"find:deployment.daily-report",
			"update-and-reuse:deployment_existing:file_uploaded_once",
		]);
		expect(state.getResource({ type: "deployment", name: "daily-report", provider: "bailian" })?.remote_id).toBe(
			"deployment_existing",
		);
	});

	test("skill ConflictError → multi searchNames → adopt as-is without rebuild", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "exec-conflict-skill-"));
		writeFileSync(
			join(projectDir, "SKILL.md"),
			"---\nname: manifest-skill\ndescription: Conflict adoption fixture\n---\n",
		);
		const skillConfig: ProjectConfig = {
			version: "1",
			providers: { bailian: { api_key: "test", workspace_id: "ws" } },
			defaults: { provider: "bailian" },
			skills: {
				"my-skill": {
					source: "SKILL.md",
				},
			},
		};

		const existingSkill: RemoteResource = { id: "skill_remote", type: "skill" };
		const findNames: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async (_type: string, name: string) => {
				findNames.push(name);
				return findNames.length === 4 ? existingSkill : null;
			},
			createSkill: async () => {
				throw new ConflictError(409, "已存在自定义相同SkillName", "Bailian API");
			},
			updateSkill: async () => {
				throw new Error("updateSkill should not be called — skill adopt is as-is");
			},
			deleteSkill: async () => {},
			uploadFile: async () => ({ id: "file_1", name: "test.zip", purpose: "skill", size: 100 }),
			deleteFile: async () => {},
		} as unknown as ProviderAdapter;

		const skillPlan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "skill", name: "my-skill", provider: "bailian" },
					reason: "Resource does not exist in state",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		const ctx: ExecContext = {
			config: skillConfig,
			configPath: join(projectDir, "agents.yaml"),
			providers: new Map([["bailian", provider]]),
			state,
		};

		try {
			const result = await executePlan(skillPlan, ctx);

			expect(result.partial).toBe(false);
			expect(result.results[0].status).toBe("success");
			expect(findNames).toEqual(["my-skill", "manifest-skill", "my-skill", "manifest-skill"]);
			const saved = state.getResource({ type: "skill", name: "my-skill", provider: "bailian" })!;
			expect(saved.remote_id).toBe("skill_remote");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

describe("executor external-reference environment", () => {
	const byocConfig: ProjectConfig = {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: "bailian" },
		environments: {
			"byoc-env": {
				environment_id: "env_byoc_xyz",
				config: { type: "self_hosted" },
			},
		},
	};

	test("create action skips remote mutation and records environment_id in state", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "should_not_be_used", type: "environment" };
			},
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				return { id: "should_not_be_used", type: "environment" };
			},
			deleteEnvironment: async () => {
				calls.push("deleteEnvironment");
			},
		} as unknown as ProviderAdapter;

		const plan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "environment", name: "byoc-env", provider: "bailian" },
					reason: "Resource does not exist in state",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(plan, makeCtx(provider, state, byocConfig));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual([]);
		const saved = state.getResource({ type: "environment", name: "byoc-env", provider: "bailian" })!;
		expect(saved.remote_id).toBe("env_byoc_xyz");
		expect(saved.externally_managed).toBe(true);
	});

	test("removing an external environment from config only removes its state", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => ({ id: "x", type: "environment" }),
			updateEnvironment: async () => ({ id: "x", type: "environment" }),
			deleteEnvironment: async () => {
				calls.push("deleteEnvironment");
			},
		} as unknown as ProviderAdapter;

		const plan: ExecutionPlan = {
			actions: [
				{
					action: "delete",
					address: { type: "environment", name: "byoc-env", provider: "bailian" },
					reason: "Resource removed from configuration",
					before: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "environment", name: "byoc-env", provider: "bailian" },
			remote_id: "env_byoc_xyz",
			externally_managed: true,
			content_hash: "h",
		});

		const configWithoutExternalEnvironment: ProjectConfig = {
			...byocConfig,
			environments: undefined,
		};
		const result = await executePlan(plan, makeCtx(provider, state, configWithoutExternalEnvironment));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual([]);
		expect(state.getResource({ type: "environment", name: "byoc-env", provider: "bailian" })).toBeUndefined();
	});

	test("marks an existing external environment during a no-op apply", async () => {
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
		} as unknown as ProviderAdapter;
		const state = StateManager.initialize(tmpPath());
		const address = { type: "environment" as const, name: "byoc-env", provider: "bailian" };
		state.setResource({ address, remote_id: "env_byoc_xyz", content_hash: "h" });
		const plan: ExecutionPlan = {
			actions: [{ action: "no-op", address, reason: "No changes detected", dependencies: [] }],
			diagnostics: [],
		};

		await executePlan(plan, makeCtx(provider, state, byocConfig));

		expect(state.getResource(address)?.externally_managed).toBe(true);
	});
});

describe("executor recreate-on-vanished-remote", () => {
	test("falls back to create when an update fails with 404", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				throw new ApiError(404, "Environment 'env_old' was not found.", "test");
			},
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "env_new", type: "environment" };
			},
		} as unknown as ProviderAdapter;

		const address = { type: "environment" as const, name: "my-env", provider: "bailian" };
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "update",
					address,
					reason: "Local config changed",
					before: { content_hash: "h_old" },
					after: { content_hash: "h_new" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		state.setResource({ address, remote_id: "env_old", content_hash: "h_old" });

		const result = await executePlan(plan, makeCtx(provider, state));

		expect(calls).toEqual(["updateEnvironment", "createEnvironment"]);
		expect(result.results[0]?.status).toBe("success");
		expect(state.getResource(address)?.remote_id).toBe("env_new");
	});

	test("does not retry non-404 update failures", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				throw new ApiError(500, "boom", "test");
			},
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "env_new", type: "environment" };
			},
		} as unknown as ProviderAdapter;

		const address = { type: "environment" as const, name: "my-env", provider: "bailian" };
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "update",
					address,
					reason: "Local config changed",
					before: { content_hash: "h_old" },
					after: { content_hash: "h_new" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		state.setResource({ address, remote_id: "env_old", content_hash: "h_old" });

		const result = await executePlan(plan, makeCtx(provider, state));

		expect(calls).toEqual(["updateEnvironment"]);
		expect(result.results[0]?.status).toBe("failed");
	});
});

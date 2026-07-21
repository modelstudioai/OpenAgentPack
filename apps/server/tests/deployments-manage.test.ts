import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let activeProvider = "qoder";
let executionStatus: "success" | "failed" = "success";
let executionGate: Promise<void> | undefined;
const missingRemoteIds = new Set<string>();
const unavailableProviders = new Set<string>();
let runError: { type: string; message: string } | undefined;

mock.module("@/services/runtime-factory", () => ({
	loadCompiledRuntimeInput: async (playbookId: string, providerOverride?: string) => {
		const provider = providerOverride ?? activeProvider;
		if (unavailableProviders.has(provider)) throw new Error(`credentials unavailable for ${provider}`);
		return {
			projectName: "test",
			configPath: "/tmp/agents.yaml",
			statePath: "/tmp/state.json",
			stateBackend: {},
			stateScope: { projectId: "test" },
			providers: new Map(),
			config: {
				_resolved: true,
				version: "1",
				providers: { [provider]: {} },
				defaults: { provider },
				environments: { base: {} },
				agents: { agent: { model: "model", instructions: "test" } },
			},
			agentId: "agent",
			compiled: { agentId: "agent", agent: { id: playbookId }, agentConfigHash: "hash" },
		};
	},
}));

mock.module("@openagentpack/sdk", () => ({
	UserError: class UserError extends Error {},
	syncAgentResourcesWithStateBackend: async () => ({ status: "completed" }),
	writeProjectRuntime: async (input: unknown, fn: (ctx: unknown) => unknown) => fn({ input }),
	planProjectContext: async (ctx: { input: { config: { deployments?: Record<string, unknown> } } }) => {
		const configured = Object.keys(ctx.input.config.deployments ?? {});
		const id = configured[0] ?? globalThis.__deploymentDeleteId;
		return {
			executionContext: ctx,
			plan: {
				diagnostics: [],
				actions: [
					{
						address: { type: "deployment", name: id, provider: activeProvider },
						action: configured.length ? "create" : "delete",
						dependencies: [],
					},
				],
			},
			destructiveActions: [],
		};
	},
	executePlannedProject: async (planned: { plan: { actions: unknown[] } }) => {
		if (executionGate) await executionGate;
		return {
			results: planned.plan.actions.map((action) => ({
				action,
				status: executionStatus,
				...(executionStatus === "failed" ? { error: "provider failed" } : {}),
			})),
			partial: executionStatus === "failed",
		};
	},
	getDeploymentDetailsForContext: async (
		ctx: { input: { config: { defaults: { provider: string }; deployments: Record<string, unknown> } } },
		id: string,
	) => {
		if (missingRemoteIds.has(id)) throw new Error("remote deployment not found");
		return { provider: ctx.input.config.defaults.provider, info: { id: `remote-${id}`, status: "active" } };
	},
	pauseDeploymentForContext: async () => ({ id: "remote", status: "paused" }),
	runDeploymentForContext: async (_ctx: unknown, name: string) => ({
		name,
		provider: activeProvider,
		result: { session_id: runError ? null : "session", ...(runError ? { error: runError } : {}) },
	}),
}));

const manage = await import("../src/services/deployments/manage");
const testDir = await mkdtemp(join(tmpdir(), "opencma-deployments-"));
const storePath = join(testDir, "deployments.json");
process.env.AGENTS_DEPLOYMENTS_PATH = storePath;

function input(name: string) {
	return { name, playbookId: "base", prompt: "test", expression: "0 9 * * *", timezone: "Asia/Shanghai" };
}

async function stored() {
	try {
		return JSON.parse(await readFile(storePath, "utf8")) as {
			deployments: Array<{ id: string; name: string; provider?: string }>;
		};
	} catch {
		return { deployments: [] };
	}
}

beforeEach(async () => {
	await rm(storePath, { force: true });
	activeProvider = "qoder";
	executionStatus = "success";
	executionGate = undefined;
	missingRemoteIds.clear();
	unavailableProviders.clear();
	runError = undefined;
	globalThis.__deploymentDeleteId = undefined;
});

afterAll(async () => {
	delete process.env.AGENTS_DEPLOYMENTS_PATH;
	await rm(testDir, { recursive: true, force: true });
});

describe("managed deployments consistency", () => {
	test("does not persist a deployment when provider apply returns a failed result", async () => {
		executionStatus = "failed";
		await expect(manage.createManagedDeployment(input("failed"))).rejects.toThrow("provider failed");
		expect((await stored()).deployments).toHaveLength(0);
	});

	test("retains the local record when provider delete returns a failed result", async () => {
		const created = await manage.createManagedDeployment(input("keep-me"));
		globalThis.__deploymentDeleteId = created.id;
		executionStatus = "failed";
		await expect(manage.deleteManagedDeployment(created.id)).rejects.toThrow("provider failed");
		expect((await stored()).deployments.map((item) => item.id)).toEqual([created.id]);
	});

	test("keeps using the provider that owned the deployment after the active provider changes", async () => {
		await manage.createManagedDeployment(input("qoder-owned"));
		activeProvider = "claude";
		const [deployment] = await manage.listManagedDeployments();
		expect(deployment?.provider).toBe("qoder");
	});

	test("concurrent creates retain both records", async () => {
		let release!: () => void;
		executionGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = manage.createManagedDeployment(input("first"));
		const second = manage.createManagedDeployment(input("second"));
		await Bun.sleep(10);
		release();
		await Promise.all([first, second]);
		expect(new Set((await stored()).deployments.map((item) => item.name))).toEqual(new Set(["first", "second"]));
	});

	test("one missing remote deployment does not make the whole list fail", async () => {
		const missing = await manage.createManagedDeployment(input("missing"));
		await manage.createManagedDeployment(input("healthy"));
		missingRemoteIds.add(missing.id);
		const deployments = await manage.listManagedDeployments();
		expect(deployments).toHaveLength(2);
		expect(deployments.find((item) => item.id === missing.id)?.status).toBe("unavailable");
		expect(deployments.find((item) => item.name === "healthy")?.status).toBe("active");
	});

	test("one provider with unavailable credentials does not make the whole list fail", async () => {
		await manage.createManagedDeployment(input("qoder"));
		unavailableProviders.add("qoder");
		const deployments = await manage.listManagedDeployments();
		expect(deployments).toHaveLength(1);
		expect(deployments[0]?.status).toBe("unavailable");
	});

	test("surfaces a provider-reported deployment run error", async () => {
		const created = await manage.createManagedDeployment(input("run-error"));
		runError = { type: "capacity", message: "provider rejected the run" };
		await expect(manage.runManagedDeployment(created.id)).rejects.toThrow("provider rejected the run");
	});
});

declare global {
	var __deploymentDeleteId: string | undefined;
}

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApiError,
	executePlannedProject,
	InMemoryStateManager,
	type ProjectRuntimeContext,
	type ProviderAdapter,
	planProjectContext,
	ResourceRuntimeError,
	resolveProjectConfigFromObject,
	UserError,
} from "../../src/index.ts";
import { resourcePlanFingerprint } from "../../src/internal/planner/plan-fingerprint.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function context(extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
	const loaded = await resolveProjectConfigFromObject(
		{
			version: "1",
			providers: { bailian: { api_key: "fixture-key" } },
			defaults: { provider: "bailian" },
			environments: { dev: { config: { type: "cloud" } } },
			agents: {},
			...extra,
		},
		{ resolveEnv: false, textFileReferences: "literal" },
	);
	const state = InMemoryStateManager.fromJSON({ resources: [] });
	const provider = {
		name: "bailian",
		findResource: async () => null,
		createEnvironment: async (name: string) => ({ id: `env_${name}`, name }),
		createAgent: async (name: string) => ({ id: `agent_${name}`, name, version: 1 }),
		...overrides,
	} as unknown as ProviderAdapter;
	return {
		projectName: "contract",
		configPath: "/virtual/agents.yaml",
		config: loaded.config,
		state,
		providers: new Map([["bailian", provider]]),
	} as ProjectRuntimeContext;
}

const plan = (runtime: ProjectRuntimeContext, structured = true) =>
	planProjectContext(runtime, {
		provider: "bailian",
		refresh: false,
		...(structured ? { resultDetail: "structured" as const } : {}),
	});

test("default public shapes, legacy failure strings and original thrown errors stay unchanged", async () => {
	const response = new ApiError(429, "original service failure", "Bailian API");
	const runtime = await context(
		{},
		{
			createEnvironment: async () => {
				throw response;
			},
		},
	);
	const planned = await plan(runtime, false);
	expect(Object.hasOwn(planned, "fingerprint")).toBe(false);
	const execution = await executePlannedProject(planned);
	expect(Object.keys(execution)).toEqual(["results", "partial"]);
	expect(Object.keys(execution.results[0]!)).toEqual(["action", "status", "error"]);
	expect(execution.results[0]!.error).toBe(response.message);
	expect(execution.partial).toBe(true);
	const persistenceFailure = new Error("original storage error");
	const second = await context();
	second.state.save = async () => {
		throw persistenceFailure;
	};
	await expect(executePlannedProject(await plan(second, false))).rejects.toBe(persistenceFailure);
	const blocked = await plan(await context(), false);
	blocked.destructiveActions = [{ ...blocked.plan.actions[0]!, action: "delete" }];
	await expect(executePlannedProject(blocked)).rejects.toBeInstanceOf(UserError);
});

test("structured success reports resource identities and a stable semantic plan fingerprint", async () => {
	const runtime = await context();
	const planned = await plan(runtime);
	expect(planned.fingerprint).toMatch(/^resource-plan-v1:[a-f0-9]{64}$/);
	const changedText = {
		...planned,
		plan: {
			...planned.plan,
			actions: planned.plan.actions.map((action) => ({ ...action, reason: "localized message" })),
		},
	};
	expect(resourcePlanFingerprint(changedText)).toBe(planned.fingerprint!);
	const changedTarget = {
		...planned,
		plan: {
			...planned.plan,
			actions: planned.plan.actions.map((action) => ({ ...action, after: { content_hash: "different" } })),
		},
	};
	expect(resourcePlanFingerprint(changedTarget)).not.toBe(planned.fingerprint!);
	const execution = await executePlannedProject(planned, { resultDetail: "structured" });
	expect(execution).toMatchObject({
		outcome: "succeeded",
		mutationStarted: true,
		partial: false,
		results: [{ status: "success", resource: { remoteId: "env_dev" } }],
	});
	const fingerprint = resourcePlanFingerprint(planned);
	const resource = runtime.state.listResources()[0]!;
	runtime.state.setResource({
		...resource,
		remote_snapshot: { timestamp: "unrelated", secret: "never in fingerprint" },
	});
	expect(resourcePlanFingerprint(planned)).toBe(fingerprint);
	runtime.state.setResource({ ...resource, remote_id: "env_changed", version: 2 });
	expect(resourcePlanFingerprint(planned)).not.toBe(fingerprint);
});

test("preflight policy errors have an explicit no-mutation guarantee without changing legacy policy", async () => {
	const planned = await plan(await context());
	planned.destructiveActions = [{ ...planned.plan.actions[0]!, action: "delete" }];
	try {
		await executePlannedProject(planned, { resultDetail: "structured" });
		throw new Error("expected policy failure");
	} catch (error) {
		expect(error).toBeInstanceOf(ResourceRuntimeError);
		expect((error as ResourceRuntimeError).info).toMatchObject({
			code: "resource.policy_blocked",
			phase: "prepare",
			mutationStarted: false,
		});
	}
});

test("write failures and dependent skips expose safe errors; HTTP retryability never authorizes replay", async () => {
	const secret = "private-fixture-value";
	const runtime = await context(
		{
			agents: {
				base: { model: "auto", instructions: "fixture", environment: "dev" },
				main: { model: "auto", instructions: "fixture", multiagent: { type: "coordinator", agents: ["base"] } },
			},
		},
		{
			createAgent: async () => {
				throw new ApiError(429, secret, "Bailian API");
			},
		},
	);
	const execution = await executePlannedProject(await plan(runtime), { resultDetail: "structured" });
	expect(execution.outcome).toBe("unknown");
	expect(execution.mutationStarted).toBe(true);
	const failed = execution.results.find((result) => result.action.address.name === "base")!;
	expect(failed.errorInfo).toMatchObject({
		code: "resource.provider_failed",
		phase: "execute",
		httpStatus: 429,
		retryable: true,
		mutationStarted: true,
	});
	expect(JSON.stringify(failed.errorInfo)).not.toContain(secret);
	expect(execution.results.find((result) => result.action.address.name === "main")).toMatchObject({
		status: "skipped",
		errorInfo: { code: "resource.dependency_failed", mutationStarted: false },
	});
});

test("a source lost after planning is a preparation failure while independent successful resources remain visible", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sdk-result-skill-"));
	temporary.push(directory);
	await writeFile(
		join(directory, "SKILL.md"),
		"---\nname: contract-skill\ndescription: fixture skill\n---\nUse fixture.\n",
	);
	const runtime = await context({ skills: { review: { source: directory, origin: "custom" } } });
	const planned = await plan(runtime);
	await rm(directory, { recursive: true });
	const execution = await executePlannedProject(planned, { resultDetail: "structured" });
	expect(execution.outcome).toBe("partial");
	expect(execution.results.find((result) => result.action.address.type === "environment")).toMatchObject({
		status: "success",
		resource: { remoteId: "env_dev" },
	});
	expect(execution.results.find((result) => result.action.address.type === "skill")).toMatchObject({
		status: "failed",
		errorInfo: { phase: "prepare", mutationStarted: false },
	});
});

test("state persistence failure carries completed results and remains unknown after remote writes", async () => {
	const runtime = await context();
	const original = new Error("storage unavailable");
	runtime.state.save = async () => {
		throw original;
	};
	try {
		await executePlannedProject(await plan(runtime), { resultDetail: "structured" });
		throw new Error("expected persistence failure");
	} catch (error) {
		expect(error).toBeInstanceOf(ResourceRuntimeError);
		const failure = error as ResourceRuntimeError;
		expect(failure.info).toMatchObject({
			code: "resource.state_persist_failed",
			phase: "persist_state",
			mutationStarted: true,
		});
		expect(failure.execution).toMatchObject({
			outcome: "unknown",
			results: [{ status: "success", resource: { remoteId: "env_dev" } }],
		});
	}
});

test("structured feedback failures wait for already-started concurrent writes before returning a report", async () => {
	const gate = Promise.withResolvers<{ id: string }>();
	const started = Promise.withResolvers<void>();
	const feedback = Promise.withResolvers<void>();
	const runtime = await context(
		{ environments: { dev: { config: { type: "cloud" } }, other: { config: { type: "cloud" } } } },
		{
			createEnvironment: async (name: string) => {
				if (name === "other") {
					started.resolve();
					return gate.promise;
				}
				return { id: "env_dev" };
			},
		},
	);
	let settled = false;
	const execution = executePlannedProject(await plan(runtime), {
		resultDetail: "structured",
		concurrency: 2,
		onFeedback: (event) => {
			if (event.resource?.name === "dev") {
				feedback.resolve();
				throw new Error("feedback failed");
			}
		},
	}).catch((error: unknown) => {
		settled = true;
		return error;
	});
	await Promise.all([started.promise, feedback.promise]);
	expect(settled).toBe(false);
	gate.resolve({ id: "env_other" });
	const error = await execution;
	expect(error).toBeInstanceOf(ResourceRuntimeError);
	expect((error as ResourceRuntimeError).execution?.results).toHaveLength(2);
	expect(
		(error as ResourceRuntimeError).execution?.results.find((result) => result.action.address.name === "other"),
	).toMatchObject({ status: "success", resource: { remoteId: "env_other" } });
});

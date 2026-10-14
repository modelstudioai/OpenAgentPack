import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { refreshState } from "../../src/internal/planner/refresh.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import {
	mapDeployment as mapBailianDeployment,
	mapDeploymentUpdate as mapBailianDeploymentUpdate,
} from "../../src/internal/providers/bailian/mapper.ts";
import type { ResolvedDeploymentRefs } from "../../src/internal/providers/interface.ts";
import { mapDeployment as mapQoderDeployment } from "../../src/internal/providers/qoder/mapper.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { DeploymentDecl, ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";
import { addressKey } from "../../src/internal/types/state.ts";

const BASE = "https://bailian.test";
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function deployment(environmentVariables?: DeploymentDecl["environment_variables"]): DeploymentDecl {
	return {
		agent: "assistant",
		initial_events: [{ type: "user.message", content: "run" }],
		...(environmentVariables !== undefined ? { environment_variables: environmentVariables } : {}),
	};
}

function config(provider = "bailian", environmentVariables?: DeploymentDecl["environment_variables"]): ProjectConfig {
	return {
		version: "1",
		providers: { [provider]: {} },
		defaults: { provider },
		environments: { sandbox: { environment_id: "env_1", config: { type: "cloud" } } },
		agents: { assistant: { model: "qwen3", instructions: "help", environment: "sandbox" } },
		deployments: { task: deployment(environmentVariables) },
	};
}

function refs(): ResolvedDeploymentRefs {
	return { agent_id: "agent_1", environment_id: "env_1", vault_ids: [], memory_store_ids: {} };
}

interface CapturedCall {
	url: string;
	method: string;
	body?: unknown;
}

function mockResponses(responses: unknown[]): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
		const response = responses[calls.length];
		if (response === undefined) throw new Error("Unexpected mocked Deployment HTTP request");
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
		});
		return Response.json(response);
	}) as unknown as typeof fetch;
	return calls;
}

const validCases: Array<{ provider: string; variables: DeploymentDecl["environment_variables"] }> = [
	{ provider: "bailian", variables: { MODE: "on", COMPLEX: "alpha=beta;中文", EMPTY: "" } },
	{ provider: "bailian", variables: {} },
	{ provider: "qoder", variables: "MODE=on;EMPTY=" },
	{ provider: "qoder", variables: "" },
];

describe("Deployment environment variable declarations", () => {
	test("rejects an own __proto__ YAML key before schema parsing or mapper transmission", () => {
		const variables = parseYaml("__proto__: value\nNORMAL: value\n") as Record<string, string>;
		expect(Object.hasOwn(variables, "__proto__")).toBe(true);
		const project = config("bailian", variables);
		const parsed = projectConfigSchema.safeParse(project);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues.some((issue) => issue.message.includes("__proto__"))).toBe(true);
		}
		expect(validateProjectConfig(project)).toContainEqual(
			expect.objectContaining({ code: "bailian.deployment.environment_variables.invalid" }),
		);
		expect(() => mapBailianDeployment("task", deployment(variables), refs())).toThrow("__proto__");
		expect(() => mapBailianDeploymentUpdate("task", deployment(variables), refs())).toThrow("__proto__");
	});

	test("preserves normal constructor and prototype map keys", () => {
		const variables = { constructor: "constructor-value", prototype: "prototype-value", NORMAL: "value" };
		expect(projectConfigSchema.parse(config("bailian", variables)).deployments?.task?.environment_variables).toEqual(
			variables,
		);
		expect(mapBailianDeployment("task", deployment(variables), refs())).toHaveProperty(
			"environment_variables",
			variables,
		);
	});
	test.each(validCases)("accepts the provider's existing wire shape %j", ({ provider, variables }) => {
		const project = config(provider, variables);
		const parsed = projectConfigSchema.parse(project);
		expect(parsed.deployments?.task?.environment_variables).toEqual(variables);
		expect(validateProjectConfig(project).filter((issue) => issue.code.includes("environment_variables"))).toEqual([]);
	});

	test.each([
		{ variables: null },
		{ variables: ["MODE=on"] },
		{ variables: { MODE: 1 } },
	])("rejects values outside string or string-map schema %j", ({ variables }) => {
		const project = config();
		const parsed = projectConfigSchema.safeParse({
			...project,
			deployments: { task: { ...deployment(), environment_variables: variables } },
		});
		expect(parsed.success).toBe(false);
	});

	test.each([
		{ provider: "bailian", variables: "MODE=on", kind: "invalid" },
		{ provider: "qoder", variables: { MODE: "on" }, kind: "invalid" },
		{ provider: "claude", variables: { MODE: "on" }, kind: "unsupported" },
		{ provider: "ark", variables: "MODE=on", kind: "unsupported" },
	])("rejects incompatible provider declarations %j", ({ provider, variables, kind }) => {
		const diagnostics = validateProjectConfig(config(provider, variables));
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: `${provider}.deployment.environment_variables.${kind}` }),
		);
	});

	test("Bailian and Qoder mappers reject the other provider's shape", () => {
		expect(() => mapBailianDeployment("task", deployment("MODE=on"), refs())).toThrow("string-valued object");
		expect(() => mapQoderDeployment("task", deployment({ MODE: "on" }), refs())).toThrow("string format");
		expect(mapQoderDeployment("task", deployment("MODE=on;EMPTY="), refs())).toMatchObject({
			environment_variables: "MODE=on;EMPTY=",
		});
	});
});

describe("Bailian Deployment environment variable mapping", () => {
	test.each([
		{ variables: { MODE: "on", COMPLEX: "alpha=beta;中文", EMPTY: "" } },
		{ variables: {} },
	])("create sends the exact object without string serialization %j", async ({ variables }) => {
		const calls = mockResponses([{ id: "depl_1", type: "deployment", environment_variables: variables }]);
		await new BailianAdapter("test", undefined, BASE).createDeployment(
			"task",
			deployment(variables),
			refs(),
			"/tmp/agents.yaml",
		);
		expect(calls).toEqual([
			{
				url: `${BASE}/deployments`,
				method: "POST",
				body: {
					name: "task",
					agent: { id: "agent_1" },
					environment_id: "env_1",
					initial_events: [{ role: "user", type: "message", content: [{ type: "text", text: "run" }] }],
					environment_variables: variables,
				},
			},
		]);
	});

	test("create omits absent variables and update sends an empty map for removed variables", () => {
		expect(mapBailianDeployment("task", deployment(), refs())).not.toHaveProperty("environment_variables");
		expect(mapBailianDeploymentUpdate("task", deployment(), refs())).toHaveProperty("environment_variables", {});
	});

	test("update sends the exact variable replacement object", async () => {
		const calls = mockResponses([
			{ id: "depl_1", environment_variables: { OLD: "value" } },
			{ id: "depl_1", environment_variables: { NEW: "value" } },
		]);
		await new BailianAdapter("test", undefined, BASE).updateDeployment(
			"depl_1",
			"task",
			deployment({ NEW: "value" }),
			refs(),
			"/tmp/agents.yaml",
		);
		expect(calls).toEqual([
			{ url: `${BASE}/deployments/depl_1`, method: "GET" },
			{
				url: `${BASE}/deployments/depl_1`,
				method: "POST",
				body: {
					name: "task",
					agent: { id: "agent_1" },
					environment_id: "env_1",
					initial_events: [{ role: "user", type: "message", content: [{ type: "text", text: "run" }] }],
					environment_variables: { NEW: "value" },
					description: "",
					vault_ids: [],
					resources: [],
					schedule: null,
				},
			},
		]);
	});

	test.each([{ variables: { MODE: "on" } }, { variables: {} }])("get and list preserve variable maps %j", async ({
		variables,
	}) => {
		const response = { id: "depl_1", status: "active", environment_variables: variables };
		mockResponses([response, { data: [response] }]);
		const adapter = new BailianAdapter("test", undefined, BASE);
		const detail = await adapter.getDeploymentById("depl_1");
		const listed = await adapter.listDeployments();
		expect(detail.environment_variables).toEqual(variables);
		expect(detail.attributes).toEqual(response);
		expect(listed.deployments[0]?.environment_variables).toEqual(variables);
		expect(listed.deployments[0]?.attributes).toEqual(response);
	});

	test.each([
		{ variables: undefined },
		{ variables: null },
		{ variables: "MODE=on" },
		{ variables: { MODE: 1 } },
	])("retains raw unexpected response shapes without lifting %j", async ({ variables }) => {
		const response = { id: "depl_1", status: "active", environment_variables: variables };
		mockResponses([response]);
		const detail = await new BailianAdapter("test", undefined, BASE).getDeploymentById("depl_1");
		expect(detail).not.toHaveProperty("environment_variables");
		expect(detail.attributes).toEqual(JSON.parse(JSON.stringify(response)));
	});
});

test("Bailian Deployment variable changes and removal apply and converge to no-op", async () => {
	const directory = mkdtempSync(join(tmpdir(), "deployment-environment-"));
	try {
		const project = config("bailian", { MODE: "one", REGION: "cn" });
		const state = StateManager.initialize(join(directory, "state.json"));
		const dependencyAddresses: ResourceAddress[] = [
			{ type: "environment", name: "sandbox", provider: "bailian" },
			{ type: "agent", name: "assistant", provider: "bailian" },
		];
		for (const address of dependencyAddresses) {
			state.setResource({ address, remote_id: address.type === "agent" ? "agent_1" : "env_1", content_hash: "" });
		}
		for (const resource of state.listResources()) {
			state.setResource({
				...resource,
				content_hash: await computeResourceHash(resource.address, project, undefined, state),
			});
		}
		const address: ResourceAddress = { type: "deployment", name: "task", provider: "bailian" };
		let remote: Record<string, unknown> = {};
		const variableWrites: unknown[] = [];
		let requestCount = 0;
		globalThis.fetch = mock(async (_input: string | URL, init?: RequestInit) => {
			requestCount += 1;
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				variableWrites.push(body.environment_variables);
				remote = { ...remote, ...body, id: "depl_1", type: "deployment", status: "active" };
			}
			return Response.json(remote);
		}) as unknown as typeof fetch;
		const adapter = new BailianAdapter("test", undefined, BASE);
		const context = {
			config: project,
			configPath: join(directory, "agents.yaml"),
			state,
			providers: new Map([["bailian", adapter]]),
		};
		const firstHash = await computeResourceHash(address, project, undefined, state);
		project.deployments!.task!.environment_variables = { REGION: "cn", MODE: "one" };
		expect(await computeResourceHash(address, project, undefined, state)).toBe(firstHash);
		for (const stage of ["create", "change", "remove"] as const) {
			if (stage === "change") project.deployments!.task!.environment_variables = { MODE: "two" };
			if (stage === "remove") delete project.deployments!.task!.environment_variables;
			const plan = await buildPlan(project, state.getStateFile());
			expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
			expect(plan.actions.find((action) => action.address.type === "deployment")?.action).toBe(
				stage === "create" ? "create" : "update",
			);
			const result = await executePlan(plan, context);
			expect(result.partial).toBe(false);
			expect(result.results.every((actionResult) => actionResult.status === "success")).toBe(true);
			const converged = await buildPlan(project, state.getStateFile());
			expect(converged.actions.every((action) => action.action === "no-op")).toBe(true);
			expect((await adapter.getDeploymentById("depl_1")).environment_variables).toEqual(
				stage === "remove" ? {} : project.deployments!.task!.environment_variables,
			);
		}
		expect(variableWrites).toEqual([{ REGION: "cn", MODE: "one" }, { MODE: "two" }, {}]);
		expect(adapter.getDriftSupport("deployment")).toBe("unsupported");
		const beforeRefresh = requestCount;
		await refreshState(state, context.providers, {
			config: project,
			quiet: true,
			resourceKeys: new Set([addressKey(address)]),
		});
		expect(requestCount).toBe(beforeRefresh);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

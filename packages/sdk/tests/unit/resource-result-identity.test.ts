import { afterEach, expect, test } from "bun:test";
import {
	ApiError,
	createProjectRuntime,
	executePlannedProject,
	InMemoryStateManager,
	planProjectContext,
	ResourceRuntimeError,
	resolveProjectConfigFromObject,
	setDefaultFetch,
} from "../../src/index.ts";

afterEach(() => setDefaultFetch(undefined));

async function vaultRuntime() {
	const loaded = await resolveProjectConfigFromObject(
		{
			version: "1",
			providers: { bailian: { api_key: "fixture", base_url: "https://fixture.invalid/api/v1/agentstudio" } },
			defaults: { provider: "bailian" },
			agents: {},
			vaults: {
				secrets: {
					display_name: "Fixture",
					credentials: [
						{
							name: "service",
							type: "environment_variable",
							secret_name: "API_TOKEN",
							secret_value: "fixture-private-value",
						},
					],
				},
			},
		},
		{ resolveEnv: false, textFileReferences: "literal" },
	);
	return createProjectRuntime({
		projectName: "identity",
		config: loaded.config,
		state: InMemoryStateManager.fromJSON({ resources: [] }),
	});
}

test.each([
	"legacy",
	"structured",
] as const)("%s keeps Vault creation facts without changing legacy failures or marking an incomplete Vault converged", async (detail) => {
	const calls: string[] = [];
	const body = JSON.stringify({ code: "InvalidCredential", message: "original credential rejection" });
	setDefaultFetch(async (input, init) => {
		const path = new URL(String(input)).pathname.replace("/api/v1/agentstudio", "");
		calls.push(`${init?.method ?? "GET"} ${path}`);
		if (path === "/vaults") return Response.json({ id: "vault_created", name: "Fixture" });
		if (path === "/vaults/vault_created/credentials") return new Response(body, { status: 400 });
		throw new Error("unexpected fixture request");
	});
	const runtime = await vaultRuntime();
	const planned = await planProjectContext(runtime, {
		refresh: false,
		resultDetail: detail,
		mode: "create-only",
		scope: { roots: [{ provider: "bailian", type: "vault", name: "secrets" }] },
	});
	const result = await executePlannedProject(planned, { resultDetail: detail });
	expect(calls).toEqual(["POST /vaults", "POST /vaults/vault_created/credentials"]);
	expect(runtime.state.listResources()).toEqual([]);
	expect(result.results[0]).toMatchObject({ status: "failed" });
	if (detail === "structured") {
		expect(result).toMatchObject({
			outcome: "unknown",
			mutationStarted: true,
			results: [{ resource: { remoteId: "vault_created" }, errorInfo: { httpStatus: 400, mutationStarted: true } }],
		});
		expect(JSON.stringify(result.results[0]?.resource)).not.toContain("fixture-private-value");
	} else {
		expect(Object.keys(result)).toEqual(["results", "partial"]);
		expect(Object.keys(result.results[0]!)).toEqual(["action", "status", "error"]);
		expect(result.results[0]?.error).toBe(new ApiError(400, body, "Bailian API").message);
		const original = await runtime.providers
			.get("bailian")!
			.createVault("Fixture", runtime.config.vaults!.secrets!)
			.catch((error) => error);
		expect(original).toBeInstanceOf(ApiError);
		expect(original).not.toBeInstanceOf(ResourceRuntimeError);
		expect(original).toMatchObject({ statusCode: 400, responseBody: body });
	}
});

test("structured deletion retains the known resource identity after state removal", async () => {
	const runtime = await vaultRuntime();
	runtime.config.vaults = {};
	runtime.state.setResource({
		address: { provider: "bailian", type: "vault", name: "old" },
		remote_id: "vault_deleted",
		version: 2,
		content_hash: "old",
	});
	let deleted: string | undefined;
	runtime.providers = new Map([
		[
			"bailian",
			{
				name: "bailian",
				deleteVault: async (id: string) => {
					deleted = id;
				},
			} as never,
		],
	]);
	const planned = await planProjectContext(runtime, { refresh: false, resultDetail: "structured" });
	const result = await executePlannedProject(planned, { policy: "force", resultDetail: "structured" });
	expect(deleted).toBe("vault_deleted");
	expect(runtime.state.listResources()).toEqual([]);
	expect(result).toMatchObject({
		outcome: "succeeded",
		results: [{ status: "success", resource: { remoteId: "vault_deleted", version: 2 } }],
	});
});

test("nested Memory creation does not replace the Store identity in structured results", async () => {
	const runtime = await vaultRuntime();
	runtime.config.vaults = {};
	runtime.config.memory_stores = {
		notes: { name: "Notes", entries_mode: "initialize", entries: [{ key: "memo", content: "fixture" }] },
	};
	let childCreated = false;
	runtime.providers = new Map([
		[
			"bailian",
			{
				name: "bailian",
				createMemoryStore: async () => ({ id: "store_known" }),
				deleteMemoryStore: async () => {},
				updateMemoryStore: async () => ({}),
				listMemories: async () => ({ data: [] }),
				createMemory: async () => {
					childCreated = true;
					return { id: "memory_child" };
				},
			} as never,
		],
	]);
	const result = await executePlannedProject(
		await planProjectContext(runtime, { refresh: false, resultDetail: "structured" }),
		{ resultDetail: "structured" },
	);
	expect(childCreated).toBe(true);
	expect(result).toMatchObject({
		outcome: "succeeded",
		results: [{ status: "success", resource: { remoteId: "store_known" } }],
	});
});

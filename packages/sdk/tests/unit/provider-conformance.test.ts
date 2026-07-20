import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../src/internal/providers/all.ts";
import type { ResourceKind } from "../../src/internal/providers/capabilities.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { allProviders } from "../../src/internal/providers/registry.ts";

const RESOURCE_KIND_METHODS: Record<ResourceKind, { methods: string[]; skip?: boolean }> = {
	environment: { methods: ["createEnvironment", "updateEnvironment", "deleteEnvironment"] },
	vault: { methods: ["createVault", "deleteVault"] },
	skill: { methods: ["createSkill", "updateSkill", "deleteSkill"] },
	agent: { methods: ["createAgent", "updateAgent", "deleteAgent"] },
	template: { methods: ["createTemplate", "updateTemplate", "archiveTemplate"] },
	identity: { methods: ["createIdentity", "updateIdentity", "deleteIdentity"] },
	channel: { methods: ["createChannel", "updateChannel", "deleteChannel"] },
	memory_store: {
		methods: [
			"createMemoryStore",
			"deleteMemoryStore",
			"listMemoryStores",
			"getMemoryStore",
			"updateMemoryStore",
			"createMemory",
			"listMemories",
			"getMemory",
			"updateMemory",
			"deleteMemory",
		],
	},
	session: { methods: ["createSession", "listSessions", "getSession", "deleteSession"] },
	mcp_server: { methods: [], skip: true },
	multiagent: { methods: [], skip: true },
	deployment: { methods: ["createDeployment", "updateDeployment", "deleteDeployment"] },
};

const ALL_RESOURCE_KINDS: ResourceKind[] = [
	"environment",
	"vault",
	"skill",
	"agent",
	"template",
	"identity",
	"channel",
	"memory_store",
	"mcp_server",
	"multiagent",
	"deployment",
	"session",
];

const DUMMY_CONFIGS: Record<string, unknown> = {
	claude: { api_key: "sk-test-dummy" },
	qoder: { api_key: "pt-test-dummy" },
	bailian: { api_key: "sk-test-dummy", workspace_id: "ws-test" },
	ark: { api_key: "ak-test-dummy" },
};

function createDummyAdapter(providerName: string): ProviderAdapter {
	const def = allProviders().find((p) => p.name === providerName);
	if (!def) throw new Error(`Provider '${providerName}' not registered`);
	const config = DUMMY_CONFIGS[providerName];
	if (!config) throw new Error(`No dummy config for '${providerName}'`);
	return def.createAdapter(def.configSchema.parse(config));
}

const conformingProviders = allProviders().filter((providerDef) => Object.hasOwn(DUMMY_CONFIGS, providerDef.name));
const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: "dummy conformance response" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		})) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

for (const providerDef of conformingProviders) {
	describe(`Provider conformance: ${providerDef.name}`, () => {
		test("adapter.name matches registration name", () => {
			const adapter = createDummyAdapter(providerDef.name);
			expect(adapter.name).toBe(providerDef.name);
		});

		test("capabilities covers all ResourceKind values", () => {
			const declaredKinds = Object.keys(providerDef.capabilities);
			for (const kind of ALL_RESOURCE_KINDS) {
				expect(declaredKinds).toContain(kind);
			}
		});

		for (const kind of ALL_RESOURCE_KINDS) {
			const mapping = RESOURCE_KIND_METHODS[kind];
			if (mapping.skip) continue;

			const capability = providerDef.capabilities[kind];
			if (!capability) continue;

			if (capability.tier === "unsupported") {
				for (const method of mapping.methods) {
					test(`${kind}:${method} is omitted for unsupported tier (no stub)`, () => {
						const adapter = createDummyAdapter(providerDef.name);
						const fn = (adapter as any)[method];
						expect(typeof fn).not.toBe("function");
					});
				}
			}

			if (capability.tier === "native") {
				for (const method of mapping.methods) {
					test(`${kind}:${method} is implemented (not a stub throw)`, async () => {
						const adapter = createDummyAdapter(providerDef.name);
						const fn = (adapter as any)[method];
						expect(typeof fn).toBe("function");

						let threw = false;
						let message = "";
						try {
							await fn.call(adapter, "dummy-id", {}, {});
						} catch (e: any) {
							threw = true;
							message = e.message ?? "";
						}

						if (threw) {
							const isStubThrow =
								message.toLowerCase().includes("not supported") || message.toLowerCase().includes("not implemented");
							expect(isStubThrow).toBe(false);
						}
					});
				}
			}
		}
	});
}

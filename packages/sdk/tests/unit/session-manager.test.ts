import { describe, expect, test } from "bun:test";
import { buildSessionBindings, resolveSessionProvider } from "../../src/internal/session/session-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		environments: {
			dev: { config: { type: "cloud" } },
			staging: { config: { type: "cloud" } },
		},
		vaults: {
			secrets: { display_name: "Secrets", credentials: [] },
			other: { display_name: "Other", credentials: [] },
		},
		memory_stores: {
			docs: { description: "Docs store" },
			logs: { description: "Logs store" },
		},
		agents: {
			researcher: {
				model: "gpt-4",
				instructions: "You are a researcher.",
				environment: "dev",
				vault: "secrets",
				memory_stores: ["docs"],
			},
			minimal: {
				model: "gpt-4",
				instructions: "Minimal agent.",
				environment: "dev",
			},
			"no-env": {
				model: "gpt-4",
				instructions: "No env agent.",
			},
		},
		...overrides,
	};
}

function makeState(): StateManager {
	const state = StateManager.initialize("/tmp/test-session-state.json");

	const resources = [
		{ type: "agent", name: "researcher", remote_id: "agent_r1", version: 3 },
		{ type: "agent", name: "minimal", remote_id: "agent_m1" },
		{ type: "agent", name: "no-env", remote_id: "agent_ne" },
		{ type: "environment", name: "dev", remote_id: "env_dev" },
		{ type: "environment", name: "staging", remote_id: "env_staging" },
		{ type: "vault", name: "secrets", remote_id: "vault_s1" },
		{ type: "vault", name: "other", remote_id: "vault_o1" },
		{ type: "memory_store", name: "docs", remote_id: "ms_docs" },
		{ type: "memory_store", name: "logs", remote_id: "ms_logs" },
	] as const;

	for (const r of resources) {
		state.setResource({
			address: { type: r.type, name: r.name, provider: "qoder" },
			remote_id: r.remote_id,
			...("version" in r ? { version: r.version } : {}),
			content_hash: "h",
		});
	}

	return state;
}

describe("buildSessionBindings", () => {
	test("inherits environment, vault, memory_stores from agent declaration", () => {
		const config = makeConfig();
		const state = makeState();
		const bindings = buildSessionBindings("researcher", config, "qoder", state);

		expect(bindings.agent_id).toBe("agent_r1");
		expect(bindings.agent_version).toBe(3);
		expect(bindings.environment_id).toBe("env_dev");
		expect(bindings.vault_ids).toEqual(["vault_s1"]);
		expect(bindings.memory_store_ids).toEqual(["ms_docs"]);
	});

	test("CLI overrides replace agent declaration values", () => {
		const config = makeConfig();
		const state = makeState();
		const bindings = buildSessionBindings("researcher", config, "qoder", state, {
			environment: "staging",
			vault: "other",
			memoryStores: ["logs"],
			title: "Test session",
		});

		expect(bindings.environment_id).toBe("env_staging");
		expect(bindings.vault_ids).toEqual(["vault_o1"]);
		expect(bindings.memory_store_ids).toEqual(["ms_logs"]);
		expect(bindings.title).toBe("Test session");
	});

	test("explicit environmentId binds directly, bypassing config/state resolution", () => {
		const config = makeConfig();
		const state = makeState();
		// A remote id not declared in config nor present in state — used as-is.
		const bindings = buildSessionBindings("no-env", config, "qoder", state, {
			environmentId: "env_remote_xyz",
		});

		expect(bindings.environment_id).toBe("env_remote_xyz");
	});

	test("agent with no vault or memory_stores produces empty arrays", () => {
		const config = makeConfig();
		const state = makeState();
		const bindings = buildSessionBindings("minimal", config, "qoder", state);

		expect(bindings.agent_id).toBe("agent_m1");
		expect(bindings.environment_id).toBe("env_dev");
		expect(bindings.vault_ids).toEqual([]);
		expect(bindings.memory_store_ids).toEqual([]);
		expect(bindings.agent_version).toBeUndefined();
	});

	test("throws when agent not found in config", () => {
		const config = makeConfig();
		const state = makeState();
		expect(() => buildSessionBindings("nonexistent", config, "qoder", state)).toThrow(/not found in config/);
	});

	test("throws when agent has no environment and none specified", () => {
		const config = makeConfig();
		const state = makeState();
		expect(() => buildSessionBindings("no-env", config, "qoder", state)).toThrow(/no environment declared/);
	});

	test("throws when override resource not in config", () => {
		const config = makeConfig();
		const state = makeState();
		expect(() =>
			buildSessionBindings("researcher", config, "qoder", state, {
				environment: "prod",
			}),
		).toThrow(/not defined in config/);
	});

	test("throws when agent not provisioned (not in state)", () => {
		const config = makeConfig({
			agents: {
				...makeConfig().agents,
				unprovisioned: {
					model: "gpt-4",
					instructions: "Not yet applied.",
					environment: "dev",
				},
			},
		});
		const state = makeState();
		expect(() => buildSessionBindings("unprovisioned", config, "qoder", state)).toThrow(/not found in state/);
	});
});

describe("resolveSessionProvider", () => {
	test("uses explicit override provider", () => {
		const config = makeConfig();
		expect(resolveSessionProvider("researcher", config, "claude")).toBe("claude");
	});

	test("uses agent-level provider when set", () => {
		const config = makeConfig({
			agents: {
				custom: {
					model: "gpt-4",
					instructions: "test",
					environment: "dev",
					provider: "claude",
				},
			},
		});
		expect(resolveSessionProvider("custom", config)).toBe("claude");
	});

	test("uses defaults.provider when single provider not available", () => {
		const config = makeConfig({
			providers: { qoder: {}, claude: {} },
			defaults: { provider: "qoder" },
		});
		expect(resolveSessionProvider("researcher", config)).toBe("qoder");
	});

	test("uses single provider from config when only one configured", () => {
		const config = makeConfig();
		expect(resolveSessionProvider("researcher", config)).toBe("qoder");
	});

	test("throws for multi-provider with no override and no agent provider", () => {
		const config = makeConfig({
			providers: { qoder: {}, claude: {} },
		});
		expect(() => resolveSessionProvider("researcher", config)).toThrow(/multiple providers/i);
	});

	test("throws when agent not in config", () => {
		const config = makeConfig();
		expect(() => resolveSessionProvider("ghost", config)).toThrow(/not found in config/);
	});
});

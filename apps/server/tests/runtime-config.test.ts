// Apply the @hono/zod-openapi extension before any @openagentpack/sdk DTO schema is
// evaluated. Importing the sdk barrel (via buildRuntimeConfig) otherwise races the
// extension under bun's multi-file loader, leaving CoreSessionSchema.openapi undefined.
import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildRuntimeConfig, RUNTIME_PROJECT_NAME } from "../src/lib/build-runtime-config";
import { deriveWebUiStateScope, resolveStatePath } from "../src/lib/state-scope";

describe("WebUI state scope", () => {
	test("derives a fixed project scope independent of any config file", () => {
		expect(deriveWebUiStateScope()).toEqual({ projectId: RUNTIME_PROJECT_NAME });
	});

	test("default state path points to ~/.agents/playground.state.json", () => {
		const { homedir } = require("node:os");
		const { join } = require("node:path");
		expect(resolveStatePath({}, "/repo")).toBe(join(homedir(), ".agents", "playground.state.json"));
	});

	test("AGENTS_STATE_PATH overrides the default", () => {
		const cwd = "/repo";
		expect(resolveStatePath({ AGENTS_STATE_PATH: "var/state.json" }, cwd)).toBe(resolve(cwd, "var/state.json"));
	});
});

describe("buildRuntimeConfig", () => {
	const ENV_KEYS = ["AGENTS_PROVIDER", "DASHSCOPE_API_KEY", "BAILIAN_WORKSPACE_ID", "BAILIAN_BASE_URL"] as const;

	function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
		const saved = new Map<string, string | undefined>();
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
		}
		try {
			for (const [key, value] of Object.entries(overrides)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			return fn();
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test("assembles a validated config from env + playbooks; base_url omitted when unset", async () => {
		await withEnv(
			{
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "sk-test",
				BAILIAN_WORKSPACE_ID: "ws-test",
				BAILIAN_BASE_URL: undefined,
			},
			async () => {
				const loaded = await buildRuntimeConfig();
				// projectName is "" so the bailian provider stamps no agents.* (a `bl`-only marker);
				// RUNTIME_PROJECT_NAME stays the local state-scope anchor only (see the scope test above).
				expect(loaded.projectName).toBe("");
				expect((loaded.config as { _resolved?: boolean })._resolved).toBe(true);

				const provider = loaded.config.providers.bailian as Record<string, unknown>;
				expect(provider.api_key).toBe("sk-test");
				expect(provider.workspace_id).toBe("ws-test");
				// No base_url: the SDK derives the production endpoint from workspace_id.
				expect(provider.base_url).toBeUndefined();

				// environment carries the load-bearing npm package
				expect(loaded.config.environments?.["bailian-cli"]?.config.packages?.npm).toContain("bailian-cli");

				// vault secret value injected from env, structure from playbooks
				const vault = loaded.config.vaults?.secrets;
				const cred = vault?.credentials?.[0] as Record<string, unknown> | undefined;
				expect(cred?.secret_value).toBe("sk-test");
			},
		);
	});

	test("passes BAILIAN_BASE_URL through as an override when set", async () => {
		await withEnv(
			{
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "sk-test",
				BAILIAN_WORKSPACE_ID: "ws-test",
				BAILIAN_BASE_URL: "https://example.test/api",
			},
			async () => {
				const loaded = await buildRuntimeConfig();
				const provider = loaded.config.providers.bailian as Record<string, unknown>;
				expect(provider.base_url).toBe("https://example.test/api");
			},
		);
	});

	test("fails fast when a required credential env var is missing", async () => {
		await withEnv(
			{
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: undefined,
				BAILIAN_WORKSPACE_ID: "ws-test",
				BAILIAN_BASE_URL: undefined,
			},
			async () => {
				await expect(buildRuntimeConfig()).rejects.toThrow("DASHSCOPE_API_KEY");
			},
		);
	});
});

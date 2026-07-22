import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyProviderConfigToEnv,
	areRuntimeCredentialsReady,
	bootstrapRuntimeCredentialsSync,
	loadDotEnv,
	loadProviderConfigIntoEnvSync,
} from "../../src/internal/provider-config.ts";

describe("provider-config bootstrap", () => {
	test("loadDotEnv finds .env in a parent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "agents-dotenv-"));
		const nested = join(root, "a", "b");
		await mkdir(nested, { recursive: true });
		await writeFile(join(root, ".env"), "DASHSCOPE_API_KEY=from-dotenv\n", "utf8");
		const prev = process.env.DASHSCOPE_API_KEY;
		delete process.env.DASHSCOPE_API_KEY;
		try {
			const loaded = loadDotEnv(nested);
			expect(loaded).toBe(join(root, ".env"));
			expect(process.env.DASHSCOPE_API_KEY).toBe("from-dotenv");
		} finally {
			if (prev === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prev;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("loadProviderConfigIntoEnvSync without force fills only missing env vars", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-bootstrap-"));
		const configPath = join(dir, "config.json");
		const prevConfigPath = process.env.AGENTS_CONFIG_PATH;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		const prevProvider = process.env.AGENTS_PROVIDER;
		process.env.AGENTS_CONFIG_PATH = configPath;
		process.env.DASHSCOPE_API_KEY = "env-key";
		delete process.env.BAILIAN_WORKSPACE_ID;
		delete process.env.AGENTS_PROVIDER;
		await writeFile(
			configPath,
			`${JSON.stringify({
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "json-key",
				BAILIAN_WORKSPACE_ID: "json-ws",
			})}\n`,
			"utf8",
		);
		try {
			loadProviderConfigIntoEnvSync();
			expect(process.env.DASHSCOPE_API_KEY).toBe("env-key");
			expect(process.env.BAILIAN_WORKSPACE_ID).toBe("json-ws");
			expect(process.env.AGENTS_PROVIDER).toBe("bailian");
		} finally {
			if (prevConfigPath === undefined) delete process.env.AGENTS_CONFIG_PATH;
			else process.env.AGENTS_CONFIG_PATH = prevConfigPath;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("bootstrapRuntimeCredentialsSync prefers config.json over .env and shell env", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-bootstrap-full-"));
		const configPath = join(dir, "config.json");
		await writeFile(join(dir, ".env"), "DASHSCOPE_API_KEY=dotenv-key\nBAILIAN_WORKSPACE_ID=dotenv-ws\n", "utf8");
		await writeFile(
			configPath,
			`${JSON.stringify({
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "json-key",
				BAILIAN_WORKSPACE_ID: "json-ws",
			})}\n`,
			"utf8",
		);
		const prevConfigPath = process.env.AGENTS_CONFIG_PATH;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		const prevProvider = process.env.AGENTS_PROVIDER;
		process.env.AGENTS_CONFIG_PATH = configPath;
		process.env.DASHSCOPE_API_KEY = "shell-key";
		process.env.BAILIAN_WORKSPACE_ID = "shell-ws";
		process.env.AGENTS_PROVIDER = "qoder";
		try {
			bootstrapRuntimeCredentialsSync(dir);
			expect(process.env.DASHSCOPE_API_KEY).toBe("json-key");
			expect(process.env.BAILIAN_WORKSPACE_ID).toBe("json-ws");
			expect(process.env.AGENTS_PROVIDER).toBe("bailian");
			expect(areRuntimeCredentialsReady()).toBe(true);
		} finally {
			if (prevConfigPath === undefined) delete process.env.AGENTS_CONFIG_PATH;
			else process.env.AGENTS_CONFIG_PATH = prevConfigPath;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("areRuntimeCredentialsReady is false when required provider fields are missing", () => {
		const prevProvider = process.env.AGENTS_PROVIDER;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		process.env.AGENTS_PROVIDER = "bailian";
		delete process.env.DASHSCOPE_API_KEY;
		delete process.env.BAILIAN_WORKSPACE_ID;
		try {
			expect(areRuntimeCredentialsReady()).toBe(false);
		} finally {
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
		}
	});

	test("areRuntimeCredentialsReady accepts BAILIAN_BASE_URL in place of workspace_id", () => {
		const prevProvider = process.env.AGENTS_PROVIDER;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		const prevBaseUrl = process.env.BAILIAN_BASE_URL;
		process.env.AGENTS_PROVIDER = "bailian";
		process.env.DASHSCOPE_API_KEY = "sk-x";
		delete process.env.BAILIAN_WORKSPACE_ID;
		process.env.BAILIAN_BASE_URL = "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio";
		try {
			expect(areRuntimeCredentialsReady()).toBe(true);
		} finally {
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
			if (prevBaseUrl === undefined) delete process.env.BAILIAN_BASE_URL;
			else process.env.BAILIAN_BASE_URL = prevBaseUrl;
		}
	});

	test("applyProviderConfigToEnv respects force flag", () => {
		const prevProvider = process.env.AGENTS_PROVIDER;
		const prevKey = process.env.ARK_API_KEY;
		process.env.AGENTS_PROVIDER = "bailian";
		process.env.ARK_API_KEY = "old";
		try {
			applyProviderConfigToEnv({ AGENTS_PROVIDER: "ark", ARK_API_KEY: "new" });
			expect(process.env.AGENTS_PROVIDER).toBe("bailian");
			expect(process.env.ARK_API_KEY).toBe("old");

			applyProviderConfigToEnv({ AGENTS_PROVIDER: "ark", ARK_API_KEY: "forced" }, { force: true });
			expect(process.env.AGENTS_PROVIDER).toBe("ark");
			expect(process.env.ARK_API_KEY).toBe("forced");
		} finally {
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			if (prevKey === undefined) delete process.env.ARK_API_KEY;
			else process.env.ARK_API_KEY = prevKey;
		}
	});
});

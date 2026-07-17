import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyProviderConfigToEnv,
	readProviderConfig,
	validateProviderConfig,
	writeProviderConfig,
} from "@/lib/agents-config";

describe("agents-config", () => {
	test("validateProviderConfig requires provider-specific fields", () => {
		expect(() => validateProviderConfig({ AGENTS_PROVIDER: "bailian" })).toThrow("DASHSCOPE_API_KEY");
		expect(
			validateProviderConfig({
				AGENTS_PROVIDER: "qoder",
				QODER_PAT: "pat-test",
			}),
		).toEqual({
			AGENTS_PROVIDER: "qoder",
			QODER_PAT: "pat-test",
		});
	});

	test("writeProviderConfig persists provider fields only", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-config-"));
		const path = join(dir, "config.json");
		const prev = process.env.AGENTS_CONFIG_PATH;
		process.env.AGENTS_CONFIG_PATH = path;
		try {
			const saved = await writeProviderConfig({
				AGENTS_PROVIDER: "ark",
				ARK_API_KEY: "ark-key",
				DASHSCOPE_API_KEY: "should-not-persist",
			});
			expect(saved).toEqual({
				AGENTS_PROVIDER: "ark",
				ARK_API_KEY: "ark-key",
			});
			const onDisk = JSON.parse(await readFile(path, "utf8"));
			expect(onDisk).toEqual(saved);
		} finally {
			if (prev === undefined) delete process.env.AGENTS_CONFIG_PATH;
			else process.env.AGENTS_CONFIG_PATH = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("readProviderConfig backfills missing fields from process.env", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-config-"));
		const path = join(dir, "config.json");
		const prevConfigPath = process.env.AGENTS_CONFIG_PATH;
		const prevProvider = process.env.AGENTS_PROVIDER;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		const prevQoderPat = process.env.QODER_PAT;
		const prevArkKey = process.env.ARK_API_KEY;
		const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
		process.env.AGENTS_CONFIG_PATH = path;
		delete process.env.AGENTS_PROVIDER;
		process.env.DASHSCOPE_API_KEY = "from-env-key";
		process.env.BAILIAN_WORKSPACE_ID = "from-env-ws";
		process.env.QODER_PAT = "from-env-qoder";
		delete process.env.ARK_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const config = await readProviderConfig();
			expect(config).toEqual({
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "from-env-key",
				BAILIAN_WORKSPACE_ID: "from-env-ws",
				QODER_PAT: "from-env-qoder",
			});
		} finally {
			if (prevConfigPath === undefined) delete process.env.AGENTS_CONFIG_PATH;
			else process.env.AGENTS_CONFIG_PATH = prevConfigPath;
			if (prevProvider === undefined) delete process.env.AGENTS_PROVIDER;
			else process.env.AGENTS_PROVIDER = prevProvider;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
			if (prevQoderPat === undefined) delete process.env.QODER_PAT;
			else process.env.QODER_PAT = prevQoderPat;
			if (prevArkKey === undefined) delete process.env.ARK_API_KEY;
			else process.env.ARK_API_KEY = prevArkKey;
			if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("readProviderConfig prefers on-disk values over process.env", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-config-"));
		const path = join(dir, "config.json");
		const prevConfigPath = process.env.AGENTS_CONFIG_PATH;
		const prevKey = process.env.DASHSCOPE_API_KEY;
		const prevWs = process.env.BAILIAN_WORKSPACE_ID;
		const prevQoderPat = process.env.QODER_PAT;
		const prevArkKey = process.env.ARK_API_KEY;
		const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
		process.env.AGENTS_CONFIG_PATH = path;
		process.env.DASHSCOPE_API_KEY = "env-key";
		process.env.BAILIAN_WORKSPACE_ID = "env-ws";
		delete process.env.QODER_PAT;
		delete process.env.ARK_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			await writeFile(
				path,
				JSON.stringify(
					{
						AGENTS_PROVIDER: "bailian",
						DASHSCOPE_API_KEY: "disk-key",
						// BAILIAN_WORKSPACE_ID intentionally missing — should come from env
					},
					null,
					2,
				),
			);
			const config = await readProviderConfig();
			expect(config).toEqual({
				AGENTS_PROVIDER: "bailian",
				DASHSCOPE_API_KEY: "disk-key",
				BAILIAN_WORKSPACE_ID: "env-ws",
			});
		} finally {
			if (prevConfigPath === undefined) delete process.env.AGENTS_CONFIG_PATH;
			else process.env.AGENTS_CONFIG_PATH = prevConfigPath;
			if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY;
			else process.env.DASHSCOPE_API_KEY = prevKey;
			if (prevWs === undefined) delete process.env.BAILIAN_WORKSPACE_ID;
			else process.env.BAILIAN_WORKSPACE_ID = prevWs;
			if (prevQoderPat === undefined) delete process.env.QODER_PAT;
			else process.env.QODER_PAT = prevQoderPat;
			if (prevArkKey === undefined) delete process.env.ARK_API_KEY;
			else process.env.ARK_API_KEY = prevArkKey;
			if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
			await rm(dir, { recursive: true, force: true });
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

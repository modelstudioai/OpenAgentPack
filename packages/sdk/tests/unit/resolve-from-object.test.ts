import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UserError } from "../../src/internal/errors.ts";
import { resolveProjectConfig, resolveProjectConfigFromObject } from "../../src/internal/parser/index.ts";

function validRawConfig() {
	return {
		version: "1",
		providers: { bailian: { api_key: "sk-test", workspace_id: "ws-test" } },
		defaults: { provider: "bailian" },
		agents: {
			designer: {
				model: "qwen3.7-max",
				instructions: "inline instructions, no file reference",
			},
		},
	};
}

test("resolves a valid in-memory config and stamps _resolved", async () => {
	const loaded = await resolveProjectConfigFromObject(validRawConfig(), { projectName: "server" });
	expect(loaded.projectName).toBe("server");
	expect((loaded.config as { _resolved?: boolean })._resolved).toBe(true);
	expect(loaded.config.agents?.designer?.model).toBe("qwen3.7-max");
});

test("optionally resolves environment references in an in-memory config", async () => {
	const previous = process.env.OPENAGENTPACK_TEST_API_KEY;
	process.env.OPENAGENTPACK_TEST_API_KEY = "resolved-test-key";
	try {
		const raw = validRawConfig();
		raw.providers.bailian.api_key = `\${OPENAGENTPACK_TEST_API_KEY}`;
		const loaded = await resolveProjectConfigFromObject(raw, { projectName: "server", resolveEnv: true });
		expect(loaded.config.providers.bailian?.api_key).toBe("resolved-test-key");
	} finally {
		if (previous === undefined) delete process.env.OPENAGENTPACK_TEST_API_KEY;
		else process.env.OPENAGENTPACK_TEST_API_KEY = previous;
	}
});

test("throws UserError listing field paths on schema failure", async () => {
	const bad = { version: "1" }; // missing required providers
	let caught: unknown;
	try {
		await resolveProjectConfigFromObject(bad, { projectName: "server" });
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(UserError);
	expect((caught as UserError).message).toContain("providers");
});

test("inline instructions are a file-resolver no-op", async () => {
	const raw = validRawConfig();
	const loaded = await resolveProjectConfigFromObject(raw, { projectName: "server" });
	expect(loaded.config.agents?.designer?.instructions).toBe("inline instructions, no file reference");
});

test("reports every local project source used for revision and file watching", async () => {
	const basePath = await mkdtemp(join(tmpdir(), "openagentpack-project-sources-"));
	try {
		await mkdir(join(basePath, "assets"));
		await mkdir(join(basePath, "skills/reviewer"), { recursive: true });
		await Promise.all([
			writeFile(join(basePath, "instructions.md"), "instructions"),
			writeFile(join(basePath, "memory.md"), "memory"),
			writeFile(join(basePath, "assets/brief.md"), "brief"),
			writeFile(join(basePath, "assets/input.csv"), "input"),
			writeFile(join(basePath, "rubric.md"), "rubric"),
		]);
		const raw = {
			...validRawConfig(),
			agents: {
				designer: {
					...validRawConfig().agents.designer,
					instructions: "./instructions.md",
					memory_stores: ["notes"],
				},
			},
			memory_stores: {
				notes: { description: "notes", entries: [{ key: "seed", content: "./memory.md" }] },
			},
			skills: { reviewer: { source: "./skills/reviewer" } },
			files: { brief: { source: "./assets/brief.md" } },
			deployments: {
				daily: {
					agent: "designer",
					initial_events: [{ type: "user.define_outcome" as const, rubric_file: "./rubric.md" }],
					resources: [{ type: "file" as const, source: "./assets/input.csv" }],
				},
			},
		};
		const loaded = await resolveProjectConfigFromObject(raw, { projectName: "server", basePath });
		expect(loaded.sourcePaths).toEqual(
			["assets/brief.md", "assets/input.csv", "instructions.md", "memory.md", "rubric.md", "skills/reviewer"].map(
				(relativePath) => join(basePath, relativePath),
			),
		);
	} finally {
		await rm(basePath, { recursive: true, force: true });
	}
});

test("file-based resolution includes the root agents.yaml source", async () => {
	const loaded = await resolveProjectConfig(resolve(import.meta.dir, "../fixtures/minimal.yaml"), {
		resolveEnv: false,
	});
	expect(loaded.sourcePaths).toContain(loaded.configPath);
});

test("rejects permission keys that do not identify an enabled builtin", async () => {
	const raw = validRawConfig();
	(raw.agents.designer as Record<string, unknown>).tools = { builtin: ["Read"], permissions: { Bash: "ask" } };
	await expect(resolveProjectConfigFromObject(raw, { projectName: "server" })).rejects.toThrow(/not enabled/);
});

test("rejects duplicate permission keys after normalization", async () => {
	const raw = validRawConfig();
	(raw.agents.designer as Record<string, unknown>).tools = {
		builtin: ["WebSearch"],
		permissions: { WebSearch: "allow", web_search: "ask" },
	};
	await expect(resolveProjectConfigFromObject(raw, { projectName: "server" })).rejects.toThrow(/duplicates/);
});

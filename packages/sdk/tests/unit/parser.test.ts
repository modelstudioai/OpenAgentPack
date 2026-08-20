import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

test("loads minimal YAML config", async () => {
	const { config, errors } = await loadConfig(resolve(FIXTURES, "minimal.yaml"));
	expect(errors).toEqual([]);
	expect(config.version).toBe("1");
	expect(config.providers.claude).toBeDefined();
	expect(config.providers.qoder).toBeDefined();
	expect(config.environments?.dev).toBeDefined();
	expect(config.agents?.assistant).toBeDefined();
	expect(config.skills?.["code-review"]).toBeDefined();
});

test("reports errors for invalid YAML", async () => {
	const { errors } = await loadConfig("/nonexistent/path.yaml");
	expect(errors.length).toBeGreaterThan(0);
	expect(errors[0]).toContain("not found");
});

test("validates agent references", async () => {
	const { config, errors } = await loadConfig(resolve(FIXTURES, "minimal.yaml"));
	expect(errors).toEqual([]);
	const agent = config.agents?.assistant;
	expect(agent?.environment).toBe("dev");
	expect(agent?.skills).toContain("code-review");
});

test("loads external agent skill references", async () => {
	const { config, errors } = await loadConfig(resolve(FIXTURES, "external-skill.yaml"));
	expect(errors).toEqual([]);

	const skills = config.agents?.assistant?.skills;
	expect(skills).toEqual([
		{ type: "official", skill_id: "pptx", version: "1.0" },
		{ type: "custom", skill_id: "skill_uploaded_xxx", version: "2.0" },
	]);
});

test("loads official MCP server references without urls", async () => {
	const { config, errors } = await loadConfig(resolve(FIXTURES, "official-mcp.yaml"));
	expect(errors).toEqual([]);

	expect(config.agents?.assistant?.mcp_servers).toEqual([{ type: "official", name: "WebSearch" }]);
	expect(config.agents?.assistant?.tools?.mcp).toEqual([
		{
			type: "mcp_toolkit",
			mcp_server_name: "WebSearch",
			default_config: { enabled: false },
			configs: [{ name: "bailian_web_search", enabled: true }],
		},
	]);
});

test("preserves environment setup scripts up to the 64 KiB UTF-8 limit", () => {
	const setupScript = `${"界".repeat(21_845)}a`;
	const result = projectConfigSchema.safeParse({
		version: "1",
		providers: { qoder: {} },
		environments: { dev: { config: { type: "cloud", setup_script: setupScript } } },
	});

	expect(Buffer.byteLength(setupScript, "utf8")).toBe(65_536);
	expect(result.success).toBe(true);
	if (result.success) expect(result.data.environments?.dev?.config.setup_script).toBe(setupScript);
});

test("rejects environment setup scripts over 64 KiB by UTF-8 byte length", () => {
	const result = projectConfigSchema.safeParse({
		version: "1",
		providers: { qoder: {} },
		environments: { dev: { config: { type: "self_hosted", setup_script: "界".repeat(21_846) } } },
	});

	expect(result.success).toBe(false);
	if (!result.success) expect(result.error.issues[0]?.message).toContain("65536 UTF-8 bytes");
});

test("preserves Agent environment variables from YAML", async () => {
	const { config, errors } = await loadConfig(resolve(FIXTURES, "agent-environment-variables.yaml"));
	expect(errors).toEqual([]);
	expect(config.agents?.assistant?.environment_variables).toEqual({
		FEATURE_FLAG: "on",
		RETRY_COUNT: "3",
	});
});

test("defaults default memory deletion to retain and accepts explicit deletion", () => {
	const base = {
		version: "1",
		providers: { qoder: {} },
		agents: {
			assistant: {
				model: { qoder: "auto" },
				instructions: "Help.",
				default_memory_store: { name: "Support memory" },
			},
		},
	};
	const retained = projectConfigSchema.parse(base);
	expect(retained.agents?.assistant?.default_memory_store?.delete_on_destroy).toBe(false);
	const deleted = projectConfigSchema.parse({
		...base,
		agents: {
			assistant: {
				...base.agents.assistant,
				default_memory_store: { name: "Support memory", delete_on_destroy: true },
			},
		},
	});
	expect(deleted.agents?.assistant?.default_memory_store?.delete_on_destroy).toBe(true);
});

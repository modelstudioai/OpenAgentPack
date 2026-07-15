import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";

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

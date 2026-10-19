import { describe, expect, test } from "bun:test";
import { buildAgentDecl } from "../../src/internal/core/agent-builder.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { mapAgent } from "../../src/internal/providers/bailian/mapper.ts";
import type { AgentDecl } from "../../src/internal/types/config.ts";

const serverName = "market-cmgjmcp00074952";

function configWithToolkit(toolkit: Record<string, unknown>) {
	return {
		version: "1",
		providers: { bailian: {} },
		agents: {
			assistant: {
				model: "qwen3.7-max",
				instructions: "Use the financial MCP tools.",
				tools: { builtin: ["read"], mcp: [toolkit] },
				mcp_servers: [{ type: "official", name: serverName }],
			},
		},
	};
}

describe("MCP tool defaults", () => {
	for (const toolkit of [
		{ mcp_server_name: serverName, default_config: { enabled: true } },
		{ mcpServerName: serverName, defaultConfig: { enabled: true } },
		{ mcp_server_name: serverName, default_config: { enabled: true }, configs: [] },
	]) {
		test(`enables all tools without placeholders: ${JSON.stringify(toolkit)}`, () => {
			const parsed = projectConfigSchema.parse(configWithToolkit(toolkit));
			const agent = parsed.agents!.assistant!;
			const expectedToolkit = {
				type: "mcp_toolkit",
				mcp_server_name: serverName,
				default_config: { enabled: true },
				configs: [],
			};
			expect(agent.tools?.mcp).toEqual([expectedToolkit]);
			const body = mapAgent("assistant", agent, { skill_ids: [] });
			expect(body.tools).toContainEqual(expectedToolkit);
		});
	}

	test("keeps tools disabled when both defaults and overrides are omitted", () => {
		const parsed = projectConfigSchema.parse(configWithToolkit({ mcp_server_name: serverName }));
		expect(parsed.agents?.assistant?.tools?.mcp).toEqual([
			{
				type: "mcp_toolkit",
				mcp_server_name: serverName,
				default_config: { enabled: false },
				configs: [],
			},
		]);
	});

	test("preserves explicit tool overrides and defaults an omitted tool enabled flag to true", () => {
		const parsed = projectConfigSchema.parse(
			configWithToolkit({
				mcp_server_name: serverName,
				default_config: { enabled: true },
				configs: [{ name: "query", enabled: false }, { name: "report" }],
			}),
		);
		const body = mapAgent("assistant", parsed.agents!.assistant!, { skill_ids: [] });
		expect(body.tools).toContainEqual({
			type: "mcp_toolkit",
			mcp_server_name: serverName,
			default_config: { enabled: true },
			configs: [
				{ name: "query", enabled: false },
				{ name: "report", enabled: true },
			],
		});
	});

	for (const invalidToolkit of [
		{ default_config: { enabled: true } },
		{ mcp_server_name: serverName, configs: null },
		{ mcp_server_name: serverName, configs: "all" },
		{ mcp_server_name: serverName, configs: [{ enabled: true }] },
		{ mcp_server_name: serverName, configs: [{ name: "query", enabled: "true" }] },
	]) {
		test(`rejects invalid toolkit configuration: ${JSON.stringify(invalidToolkit)}`, () => {
			expect(projectConfigSchema.safeParse(configWithToolkit(invalidToolkit)).success).toBe(false);
		});
	}

	for (const defaultConfig of [undefined, { enabled: false }, { enabled: true }]) {
		test(`normalizes omitted overrides for direct SDK declarations: ${JSON.stringify(defaultConfig)}`, () => {
			const agent: AgentDecl = {
				model: "qwen3.7-max",
				instructions: "Use the financial MCP tools.",
				tools: {
					builtin: ["read"],
					mcp: [{ type: "mcp_toolkit", mcp_server_name: serverName, default_config: defaultConfig }],
				},
				mcp_servers: [{ type: "official", name: serverName }],
			};
			const body = mapAgent("assistant", agent, { skill_ids: [] });
			expect(body.tools).toContainEqual({
				type: "mcp_toolkit",
				mcp_server_name: serverName,
				default_config: defaultConfig ?? { enabled: false },
				configs: [],
			});
		});
	}

	test("builds an agent with server defaults and no per-tool list", () => {
		const { agent } = buildAgentDecl(undefined, {
			model: "qwen3.7-max",
			mcp: [{ serverName, serverType: "official", defaultEnabled: true }],
		});
		expect(agent.tools?.mcp).toEqual([
			{
				type: "mcp_toolkit",
				mcp_server_name: serverName,
				default_config: { enabled: true },
				configs: [],
			},
		]);
		expect(
			projectConfigSchema.safeParse({ version: "1", providers: { bailian: {} }, agents: { assistant: agent } }).success,
		).toBe(true);
	});
});

import { expect, test } from "bun:test";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import { findMissingBailianMcpToolConfigs } from "../../src/internal/validation/bailian.ts";

test("finds Bailian MCP servers without matching tools.mcp entries", () => {
	const config: ProjectConfig = {
		version: "1",
		providers: { bailian: {} },
		defaults: { provider: "bailian" },
		agents: {
			assistant: {
				model: "qwen3.7-max",
				instructions: "test",
				tools: { builtin: ["read"] },
				mcp_servers: [{ type: "official", name: "WebSearch" }],
			},
		},
	};

	expect(findMissingBailianMcpToolConfigs(config)).toEqual([{ agentName: "assistant", serverName: "WebSearch" }]);
});

test("ignores agents that do not target Bailian", () => {
	const config: ProjectConfig = {
		version: "1",
		providers: { bailian: {}, qoder: {} },
		agents: {
			assistant: {
				provider: "qoder",
				model: "ultimate",
				instructions: "test",
				tools: { builtin: ["read"] },
				mcp_servers: [{ type: "official", name: "WebSearch" }],
			},
		},
	};

	expect(findMissingBailianMcpToolConfigs(config)).toEqual([]);
});

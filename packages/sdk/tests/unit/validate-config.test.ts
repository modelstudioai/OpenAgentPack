import { expect, test } from "bun:test";
import { collectConfigReferences, validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

// One fixture exercising both validation axes at once: an unknown skill reference
// (reference integrity) AND a Bailian MCP server without a tools.mcp entry
// (provider capability). The unified pipeline must surface both, and the
// Bailian-MCP rule must fire exactly once (it used to be duplicated).
function fixture(): ProjectConfig {
	return {
		version: "1",
		providers: { bailian: {} },
		defaults: { provider: "bailian" },
		agents: {
			assistant: {
				model: "qwen3.7-max",
				instructions: "test",
				tools: { builtin: ["read"] },
				skills: ["ghost-skill"],
				mcp_servers: [{ type: "official", name: "WebSearch" }],
			},
		},
	};
}

test("validateProjectConfig surfaces both reference and capability diagnostics", () => {
	const diagnostics = validateProjectConfig(fixture());

	const skillRef = diagnostics.filter((d) => d.code === "config.agent.skill.unknown");
	expect(skillRef).toHaveLength(1);
	expect(skillRef[0]?.message).toContain("ghost-skill");

	const bailianMcp = diagnostics.filter((d) => d.code === "bailian.agent.mcp_toolkit_missing");
	expect(bailianMcp).toHaveLength(1);
});

test("collectConfigReferences omits provider capability checks", () => {
	const diagnostics = collectConfigReferences(fixture());

	expect(diagnostics.some((d) => d.code === "config.agent.skill.unknown")).toBe(true);
	// References-only: the Bailian capability rule must NOT run here (webui playbooks use
	// server-only MCP that this rule would wrongly flag).
	expect(diagnostics.some((d) => d.code === "bailian.agent.mcp_toolkit_missing")).toBe(false);
});

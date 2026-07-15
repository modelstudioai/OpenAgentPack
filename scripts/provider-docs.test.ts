import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARK_CAPABILITIES } from "../packages/sdk/src/internal/providers/ark/capabilities.ts";
import { BAILIAN_CAPABILITIES } from "../packages/sdk/src/internal/providers/bailian/capabilities.ts";
import { CLAUDE_CAPABILITIES } from "../packages/sdk/src/internal/providers/claude/capabilities.ts";
import { QODER_CAPABILITIES } from "../packages/sdk/src/internal/providers/qoder/capabilities.ts";

const root = resolve(import.meta.dirname, "..");
const canonicalDocs = [
	"README.md",
	"README.zh-CN.md",
	"docs/reference/providers.md",
	"docs/reference/providers.zh-CN.md",
	"docs/examples.md",
	"examples/README.md",
];
const providers = [BAILIAN_CAPABILITIES, QODER_CAPABILITIES, CLAUDE_CAPABILITIES, ARK_CAPABILITIES];
const resources = [
	["Environment", "environment"],
	["Vault", "vault"],
	["Skill", "skill"],
	["Agent", "agent"],
	["MCP Server", "mcp_server"],
	["Memory Store", "memory_store"],
	["Multi-Agent", "multiagent"],
	["Deployment", "deployment"],
	["Session", "session"],
] as const;

describe("canonical provider capability tables", () => {
	for (const file of canonicalDocs) {
		test(`${file} matches provider capability declarations`, () => {
			const markdown = readFileSync(resolve(root, file), "utf8").replaceAll("**", "");
			for (const [label, resource] of resources) {
				const cells = providers.map((provider) => provider[resource].tier).join(" | ");
				expect(markdown).toContain(`| ${label} | ${cells} |`);
			}
		});
	}
});

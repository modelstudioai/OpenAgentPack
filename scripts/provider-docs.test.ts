import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArkAdapter } from "../packages/sdk/src/internal/providers/ark/adapter.ts";
import { ARK_CAPABILITIES } from "../packages/sdk/src/internal/providers/ark/capabilities.ts";
import { BailianAdapter } from "../packages/sdk/src/internal/providers/bailian/adapter.ts";
import { BAILIAN_CAPABILITIES } from "../packages/sdk/src/internal/providers/bailian/capabilities.ts";
import { ClaudeAdapter } from "../packages/sdk/src/internal/providers/claude/adapter.ts";
import { CLAUDE_CAPABILITIES } from "../packages/sdk/src/internal/providers/claude/capabilities.ts";
import { QoderAdapter } from "../packages/sdk/src/internal/providers/qoder/adapter.ts";
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

const referenceDocs = ["docs/reference/providers.md", "docs/reference/providers.zh-CN.md"];
const adapterPrototypes = [
	BailianAdapter.prototype,
	QoderAdapter.prototype,
	ClaudeAdapter.prototype,
	ArkAdapter.prototype,
];
const optionalMethodRows = [
	["List skills", "枚举 Skill", "listSkills"],
	["Download skill source during `sync`", "`sync` 时下载 Skill 源文件", "downloadAllSkillFiles"],
	["Non-blocking skill creation for Web UI polling", "Web UI 非阻塞创建 Skill 并轮询", "createSkillFromFileId"],
	["List provider models", "枚举 Provider 模型", "listModels"],
] as const;

describe("provider adapter implementation tables", () => {
	for (const file of referenceDocs) {
		test(`${file} matches optional adapter methods`, () => {
			const markdown = readFileSync(resolve(root, file), "utf8").replaceAll("**", "");
			for (const [englishLabel, chineseLabel, method] of optionalMethodRows) {
				const cells = adapterPrototypes.map((prototype) => (method in prototype ? "yes" : "no")).join(" | ");
				const label = file.endsWith("zh-CN.md") ? chineseLabel : englishLabel;
				expect(markdown).toContain(`| ${label} | ${cells} |`);
			}
		});
	}
});

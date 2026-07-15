import { describe, expect, test } from "bun:test";
import { PLAYBOOK_APP_METADATA_KEY } from "../src/metadata.ts";
import { normalizePlaybookTemplate, normalizePlaybookTemplates, type SourceAgent } from "../src/normalize.ts";

function sourceAgent(overrides: Partial<SourceAgent> = {}): SourceAgent {
	return {
		id: "agent_x",
		name: "designer",
		system: "you are a designer",
		model: { id: "qwen3.7-max", name: "Qwen3.7-Max" },
		version: 3,
		metadata: {
			template_id: "designer",
			display_name_zh: "网页设计",
			display_name_en: "Web Designer",
			sample_prompt_zh: "帮我做一个落地页",
		},
		tools: [
			{
				type: "builtin_toolkit",
				configs: [
					{ name: "bash", enabled: true },
					{ name: "read", enabled: true },
					{ name: "secret", enabled: false },
				],
			},
		],
		skills: [],
		mcpServers: [],
		...overrides,
	};
}

describe("normalize — unique id (rule 3)", () => {
	test("prefers metadata.template_id over the backend id", () => {
		expect(normalizePlaybookTemplate(sourceAgent())?.id).toBe("designer");
	});

	test("falls back to the backend id when template_id is absent", () => {
		const { template_id, ...meta } = sourceAgent().metadata ?? {};
		expect(normalizePlaybookTemplate(sourceAgent({ metadata: meta }))?.id).toBe("agent_x");
	});

	test("drops an entry that has neither template_id nor backend id", () => {
		const { template_id, ...meta } = sourceAgent().metadata ?? {};
		expect(normalizePlaybookTemplate(sourceAgent({ id: undefined, metadata: meta }))).toBeNull();
	});
});

describe("normalize — filtering (rule 1)", () => {
	test("drops runtime artefacts carrying an app_id stamp", () => {
		expect(
			normalizePlaybookTemplate(sourceAgent({ metadata: { [PLAYBOOK_APP_METADATA_KEY]: "agents-webui" } })),
		).toBeNull();
	});

	test("batch normalize drops the app_id-stamped entries", () => {
		const out = normalizePlaybookTemplates([
			sourceAgent({ metadata: { template_id: "a" } }),
			sourceAgent({ metadata: { [PLAYBOOK_APP_METADATA_KEY]: "x" } }),
		]);
		expect(out.map((t) => t.id)).toEqual(["a"]);
	});
});

describe("normalize — display from metadata (rule 2)", () => {
	test("maps locale-suffixed metadata into localized display fields", () => {
		const template = normalizePlaybookTemplate(sourceAgent());
		expect(template?.displayName).toEqual({ zh: "网页设计", en: "Web Designer" });
		expect(template?.samplePrompt).toEqual({ zh: "帮我做一个落地页" });
	});

	test("omits absent sample prompt", () => {
		const template = normalizePlaybookTemplate(
			sourceAgent({ metadata: { template_id: "x", display_name_zh: "仅名称" } }),
		);
		expect(template?.samplePrompt).toBeUndefined();
	});

	test("falls back displayName to the id when no display_name_* metadata exists", () => {
		const template = normalizePlaybookTemplate(sourceAgent({ metadata: { template_id: "designer" } }));
		expect(template?.displayName).toEqual({ zh: "designer" });
	});

	test("reads imageUrl from avatar_url metadata", () => {
		const template = normalizePlaybookTemplate(
			sourceAgent({ metadata: { template_id: "x", avatar_url: "https://cdn/x.png" } }),
		);
		expect(template?.imageUrl).toBe("https://cdn/x.png");
	});
});

describe("normalize — body mapping", () => {
	test("flattens builtin_toolkit configs (enabled only) into builtinTools", () => {
		expect(normalizePlaybookTemplate(sourceAgent())?.builtinTools).toEqual(["bash", "read"]);
	});

	test("copies system/model verbatim and defaults version to 1", () => {
		const template = normalizePlaybookTemplate(sourceAgent({ version: undefined }));
		expect(template?.system).toBe("you are a designer");
		expect(template?.model).toEqual({ id: "qwen3.7-max", name: "Qwen3.7-Max" });
		expect(template?.version).toBe(1);
	});

	test("string model is wrapped into { id }", () => {
		expect(normalizePlaybookTemplate(sourceAgent({ model: "qwen3.7-max" }))?.model).toEqual({ id: "qwen3.7-max" });
	});

	test("maps mcp servers, defaulting id to name", () => {
		const template = normalizePlaybookTemplate(sourceAgent({ mcpServers: [{ name: "WebSearch", type: "official" }] }));
		expect(template?.mcpServers).toEqual([{ id: "WebSearch", name: "WebSearch", type: "official" }]);
	});

	test("maps a customer skill to a custom resource, carrying name/url", () => {
		const template = normalizePlaybookTemplate(
			sourceAgent({ skills: [{ name: "bailian-cli-skill", type: "customer", url: "https://x/cli.zip" }] }),
		);
		expect(template?.skills).toEqual([
			{ id: "bailian-cli-skill", type: "custom", name: "bailian-cli-skill", url: "https://x/cli.zip" },
		]);
	});

	test("maps an official skill, using code as the id", () => {
		const template = normalizePlaybookTemplate(
			sourceAgent({ skills: [{ code: "skill_PPTX", name: "pptx", type: "official", version: "1.0" }] }),
		);
		expect(template?.skills).toEqual([{ id: "skill_PPTX", type: "official", name: "pptx", version: "1.0" }]);
	});
});

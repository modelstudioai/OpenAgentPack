import { describe, expect, test } from "bun:test";
import {
	getPlaybookAppId,
	getPlaybookBundle,
	listPlaybooks,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	resolvePlaybook,
	resolvePlaybookModel,
	resolveSeedPlaybook,
} from "../src/index.ts";
import type { PlaybookBundle } from "../src/types.ts";

const BAILIAN_CLI_OFFICIAL_ID = "skill_N2U0MDAwYWM2NDQ0NGFkNjljMz";

describe("seed playbooks", () => {
	test("lists the synced playbook templates", () => {
		expect(listPlaybooks().map((p) => p.id)).toEqual(["base", "editor", "designer", "researcher", "art-designer"]);
	});

	test("resolves a template into the shared runtime shape", () => {
		const resolved = resolveSeedPlaybook("designer");

		// Name is identity-only: PREFIX + id, never the localized display name.
		expect(resolved.agent.name).toBe(`${PLAYBOOK_AGENT_NAME_PREFIX}designer`);
		// system passes through the template verbatim.
		const designerTemplate = getPlaybookBundle().playbookTemplates.find((t) => t.id === "designer");
		expect(resolved.agent.system).toBe(designerTemplate?.system ?? "");
		// Bailian playbooks carry the official bailian-cli skill; non-bailian providers carry none.
		expect(resolved.agent.skills).toEqual([
			{
				skillId: BAILIAN_CLI_OFFICIAL_ID,
				type: "official",
				version: "1.0",
			},
		]);
		expect(resolved.agent.mcpServers).toEqual([]);
		expect(resolved.agent.metadata).toMatchObject({
			[PLAYBOOK_APP_METADATA_KEY]: getPlaybookAppId(),
			[PLAYBOOK_METADATA_KEY]: "designer",
		});
	});

	test("bailian catalog attaches the official bailian-cli skill", () => {
		const resolved = resolveSeedPlaybook("designer", "bailian");

		expect(resolved.agent.skills).toEqual([
			{
				skillId: BAILIAN_CLI_OFFICIAL_ID,
				type: "official",
				version: "1.0",
			},
		]);
	});

	test("ark provider exposes three homepage scenarios (no art-designer)", () => {
		const ids = listPlaybooks("ark")
			.map((p) => p.id)
			.filter((id) => id !== "base");
		expect(ids).toEqual(["editor", "designer", "researcher"]);
	});

	test("bailian provider exposes four homepage scenarios", () => {
		const ids = listPlaybooks("bailian")
			.map((p) => p.id)
			.filter((id) => id !== "base");
		expect(ids).toEqual(["editor", "designer", "researcher", "art-designer"]);
	});

	test("non-bailian providers carry no bailian-cli dependency (no skill attached)", () => {
		for (const provider of ["ark", "qoder", "claude"]) {
			const resolved = resolveSeedPlaybook("designer", provider);
			expect(resolved.agent.skills).toEqual([]);
			expect(resolved.agent.mcpServers).toEqual([]);
		}
	});

	test("applies the provider skill policy to the base fallback playbook", () => {
		expect(resolveSeedPlaybook("base", "bailian").agent.skills).toEqual([
			{
				skillId: BAILIAN_CLI_OFFICIAL_ID,
				type: "official",
				version: "1.0",
			},
		]);
		for (const provider of ["qoder", "claude", "ark"]) {
			expect(resolveSeedPlaybook("base", provider).agent.skills).toEqual([]);
		}
	});
});

describe("provider-aware infrastructure", () => {
	test("bailian defines a sandbox (installs bailian-cli) + a vault holding DASHSCOPE_API_KEY", () => {
		const bailian = resolveSeedPlaybook("designer", "bailian");
		expect(bailian.resources.vaultProfile?.credentials.map((c) => c.secret_name)).toEqual(["DASHSCOPE_API_KEY"]);
		expect(bailian.resources.environmentProfile?.config.packages?.npm).toEqual(["bailian-cli"]);
	});

	test("non-bailian providers get a bare sandbox (no packages) and no vault", () => {
		for (const provider of ["ark", "qoder", "claude"]) {
			const resolved = resolveSeedPlaybook("designer", provider);
			// Environment always present — a bare cloud sandbox, no bailian-cli package.
			expect(resolved.resources.environmentProfile?.config.type).toBe("cloud");
			expect(resolved.resources.environmentProfile?.config.packages?.npm ?? []).toEqual([]);
			// No vault for non-bailian providers.
			expect(resolved.resources.vaultProfile).toBeUndefined();
		}
	});
});

describe("resolvePlaybookModel", () => {
	test("substitutes the ark default instead of the bailian template model", () => {
		const resolved = resolveSeedPlaybook("base");
		expect(resolvePlaybookModel(resolved, "ark")).toBe("deepseek-v4-pro-260425");
	});

	test("keeps the template model when the provider has no registered default", () => {
		const resolved = resolveSeedPlaybook("base");
		expect(resolvePlaybookModel(resolved, "unknown-provider")).toBe(resolved.agent.model);
	});
});

describe("custom skill source", () => {
	test("carries a URL-declared custom skill's source and name into the resolved spec", () => {
		const bundle = structuredClone(getPlaybookBundle()) as PlaybookBundle;
		const designer = bundle.playbookTemplates.find((template) => template.id === "designer");
		if (!designer) throw new Error("designer template missing from seed");
		designer.skills = [
			{
				id: "test-skill",
				type: "custom",
				name: "test-skill",
				url: "https://example.com/skills/test-skill.zip",
			},
		];
		const resolved = resolvePlaybook(bundle, "designer");
		const custom = resolved.agent.skills.find((skill) => skill.skillId === "test-skill");
		expect(custom).toMatchObject({
			type: "custom",
			name: "test-skill",
			url: "https://example.com/skills/test-skill.zip",
		});
	});

	test("rejects a custom skill that declares neither a provider code nor a url", () => {
		const bundle = structuredClone(getPlaybookBundle()) as PlaybookBundle;
		const designer = bundle.playbookTemplates.find((template) => template.id === "designer");
		if (!designer) throw new Error("designer template missing from seed");
		designer.skills = [{ id: "no-url-skill", type: "custom" }];
		expect(() => resolvePlaybook(bundle, "designer")).toThrow(/缺少 url/);
	});
});

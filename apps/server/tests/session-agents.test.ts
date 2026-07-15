import { describe, expect, test } from "bun:test";
import {
	getDefaultPlaybook,
	getEnvironmentProfile,
	getPlaybookAppId,
	getVaultProfile,
	listPlaybooks,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
} from "@openagentpack/playbooks";
import type { ResolvedProjectConfig } from "@openagentpack/sdk";
import { compileAgentRuntime, computeAgentConfigHash, getSessionAgent } from "../src/services/agents/catalog";

const BAILIAN_CLI_OFFICIAL_ID = "skill_N2U0MDAwYWM2NDQ0NGFkNjljMz";

describe("playbook catalog", () => {
	test("exposes the seed playbooks (base + synced playbooks)", () => {
		expect(
			listPlaybooks()
				.map((s) => s.id)
				.sort(),
		).toEqual(["art-designer", "base", "designer", "editor", "researcher"]);
	});

	test("getSessionAgent falls back to the base playbook for unknown ids", () => {
		expect(getSessionAgent("base")?.id).toBe("base");
		expect(getSessionAgent("not-a-playbook")?.id).toBe(getDefaultPlaybook()?.id);
	});
});

describe("session agent compiler", () => {
	test("compiles a playbook under its Agents/ remote name", () => {
		const compiled = compileAgentRuntime("designer", baseConfig());

		expect(compiled.agentId).toBe(`${PLAYBOOK_AGENT_NAME_PREFIX}designer`);
		expect(compiled.agent.id).toBe("designer");
		expect(compiled.agentConfigHash).toHaveLength(16);
		expect(compiled.config.agents?.[compiled.agentId]).toBeDefined();
	});

	test("compiles a selected model override into the agent config", () => {
		const compiled = compileAgentRuntime("designer", baseConfig(), "glm-5.1");
		const agent = compiled.config.agents?.[compiled.agentId];

		expect(agent?.model).toBe("glm-5.1");
	});

	test("stamps playbook metadata as the shared App identity (same key Mode B writes)", () => {
		const compiled = compileAgentRuntime("base", baseConfig());
		const agent = compiled.config.agents?.[compiled.agentId];

		expect(agent?.metadata).toMatchObject({
			[PLAYBOOK_APP_METADATA_KEY]: getPlaybookAppId(),
			[PLAYBOOK_METADATA_KEY]: "base",
		});
		// agents.* marks `bl` CLI deploys only — App-created agents must NOT carry it.
		expect(agent?.metadata).not.toHaveProperty("agents.project");
		expect(agent?.metadata).not.toHaveProperty("agents.webui.agent_id");
	});

	test("composes base + role instructions", () => {
		const compiled = compileAgentRuntime("base", baseConfig());
		const agent = compiled.config.agents?.[compiled.agentId];

		expect(agent?.instructions).toContain("【角色设定】");
		// The agent declares no environment: the base sandbox is a standalone resource bound
		// per-session via environment_id, not owned by the agent decl.
		expect(agent?.environment).toBeUndefined();
	});

	test("emits official skills when playbook template declares them", () => {
		const compiled = compileAgentRuntime("researcher", baseConfig());
		const agent = compiled.config.agents?.[compiled.agentId];

		expect(agent?.skills).toEqual([{ type: "official", skill_id: BAILIAN_CLI_OFFICIAL_ID, version: "1.0" }]);
		expect(compiled.config.skills).toBeUndefined();
	});

	test("emits official skills for base playbook", () => {
		const compiled = compileAgentRuntime("base", baseConfig());
		const agent = compiled.config.agents?.[compiled.agentId];

		expect(agent?.skills).toEqual([{ type: "official", skill_id: BAILIAN_CLI_OFFICIAL_ID, version: "1.0" }]);
	});

	for (const provider of ["ark", "qoder", "claude"]) {
		test(`emits no skills for ${provider} (no bailian-cli dependency)`, () => {
			const compiled = compileAgentRuntime("researcher", baseConfig(provider));
			const agent = compiled.config.agents?.[compiled.agentId];

			expect(agent?.skills).toEqual([]);
			expect(compiled.config.skills).toBeUndefined();
		});
	}

	for (const provider of ["ark", "qoder", "claude"]) {
		test(`emits no skills for ${provider} base playbook`, () => {
			const compiled = compileAgentRuntime("base", baseConfig(provider));
			const agent = compiled.config.agents?.[compiled.agentId];

			expect(agent?.skills).toEqual([]);
			expect(compiled.config.skills).toBeUndefined();
		});
	}

	test("falls back to base for unknown playbook ids instead of throwing", () => {
		const compiled = compileAgentRuntime("missing-playbook", baseConfig());

		expect(compiled.agent.id).toBe(getDefaultPlaybook()?.id);
	});

	test("agent config hash is stable", () => {
		const config = baseConfig();

		expect(computeAgentConfigHash(config, "x")).toBe(computeAgentConfigHash(config, "x"));
	});
});

function baseConfig(provider = "bailian"): ResolvedProjectConfig {
	const vault = getVaultProfile(provider);
	const environment = getEnvironmentProfile(provider);
	return {
		version: "1",
		_resolved: true,
		providers: {
			[provider]:
				provider === "bailian"
					? {
							api_key: "test",
							workspace_id: "workspace",
						}
					: {},
		},
		defaults: { provider },
		// Non-bailian providers run on managed infra — no vault, no environment.
		vaults: vault
			? {
					[vault.name]: {
						display_name: vault.display_name,
						credentials: vault.credentials.map((cred) => ({
							name: cred.name,
							type: cred.type,
							secret_name: cred.secret_name,
							secret_value: "test-secret",
							...(cred.networking ? { networking: cred.networking } : {}),
						})),
					},
				}
			: {},
		environments: environment
			? {
					[environment.name]: {
						...(environment.description ? { description: environment.description } : {}),
						config: environment.config,
					},
				}
			: {},
	};
}

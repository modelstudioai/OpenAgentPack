import { describe, expect, test } from "bun:test";
import { collectConfigReferences, validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import type { AgentDecl, ProjectConfig } from "../../src/internal/types/config.ts";

function agent(decl: Partial<AgentDecl> = {}): AgentDecl {
	return { model: "auto", instructions: "Help.", ...decl };
}

function multiagentConfig(
	agents: Record<string, AgentDecl>,
	providers: Record<string, unknown> = { qoder: {} },
): ProjectConfig {
	return {
		version: "1",
		providers,
		defaults: { provider: Object.keys(providers)[0]! },
		agents,
	};
}

function roster(...members: string[]) {
	return { type: "coordinator" as const, agents: members };
}

function memberNames(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `worker_${i + 1}`);
}

function codes(diagnostics: Array<{ code: string }>): string[] {
	return diagnostics.map((d) => d.code);
}

describe("multiagent reference topology", () => {
	test("treats an external Agent id as a non-owned leaf", () => {
		const diagnostics = collectConfigReferences(
			multiagentConfig({
				lead: agent({ multiagent: { type: "coordinator", agents: [{ agent_id: "agent_external_1" }] } }),
			}),
		);
		expect(codes(diagnostics)).not.toContain("config.agent.multiagent.unknown");
		expect(codes(diagnostics)).not.toContain("config.agent.multiagent.self");
		expect(codes(diagnostics)).not.toContain("config.agent.multiagent.nested");
	});
	test("flags a member that is not declared in the project", () => {
		const diagnostics = collectConfigReferences(multiagentConfig({ lead: agent({ multiagent: roster("reviewer") }) }));
		expect(codes(diagnostics)).toContain("config.agent.multiagent.unknown");
		expect(diagnostics.find((d) => d.code === "config.agent.multiagent.unknown")?.message).toContain("reviewer");
	});

	test("flags a coordinator referencing itself", () => {
		const diagnostics = collectConfigReferences(multiagentConfig({ lead: agent({ multiagent: roster("lead") }) }));
		expect(codes(diagnostics)).toContain("config.agent.multiagent.self");
	});

	test("rejects a coordinator referencing another coordinator", () => {
		const diagnostics = collectConfigReferences(
			multiagentConfig({
				lead: agent({ multiagent: roster("reviewer", "worker") }),
				reviewer: agent({ multiagent: roster("worker") }),
				worker: agent(),
			}),
		);
		expect(codes(diagnostics)).toContain("config.agent.multiagent.nested");
		expect(codes(diagnostics)).not.toContain("config.agent.multiagent.cycle");
	});

	test("rejects a two-node cycle with the full path in the message", () => {
		const diagnostics = collectConfigReferences(
			multiagentConfig({
				lead: agent({ multiagent: roster("reviewer") }),
				reviewer: agent({ multiagent: roster("lead") }),
			}),
		);
		const cycle = diagnostics.find((d) => d.code === "config.agent.multiagent.cycle");
		expect(cycle).toBeDefined();
		expect(cycle?.message).toContain("lead -> reviewer -> lead");
	});

	test("rejects a three-node cycle with the full path in the message", () => {
		const diagnostics = collectConfigReferences(
			multiagentConfig({
				alpha: agent({ multiagent: roster("beta") }),
				beta: agent({ multiagent: roster("gamma") }),
				gamma: agent({ multiagent: roster("alpha") }),
			}),
		);
		const cycle = diagnostics.find((d) => d.code === "config.agent.multiagent.cycle");
		expect(cycle).toBeDefined();
		expect(cycle?.message).toContain("alpha -> beta -> gamma -> alpha");
	});

	test("emits stable diagnostics independent of agent declaration order", () => {
		const forward = multiagentConfig({
			lead: agent({ multiagent: roster("reviewer") }),
			reviewer: agent({ multiagent: roster("lead") }),
		});
		const reversed = multiagentConfig({
			reviewer: agent({ multiagent: roster("lead") }),
			lead: agent({ multiagent: roster("reviewer") }),
		});
		const forwardCodes = collectConfigReferences(forward)
			.map((d) => d.code)
			.sort();
		const reversedCodes = collectConfigReferences(reversed)
			.map((d) => d.code)
			.sort();
		expect(forwardCodes).toEqual(reversedCodes);
		expect(forwardCodes).toContain("config.agent.multiagent.cycle");
	});
});

describe("multiagent roster shape", () => {
	test("rejects an empty roster at the common schema level", () => {
		const parsed = projectConfigSchema.safeParse({
			version: "1",
			providers: { qoder: {} },
			agents: { lead: { model: "auto", instructions: "Help.", multiagent: roster() } },
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects duplicate members at the common schema level", () => {
		const parsed = projectConfigSchema.safeParse({
			version: "1",
			providers: { qoder: {} },
			agents: {
				lead: { model: "auto", instructions: "Help.", multiagent: roster("a", "b", "a") },
				a: { model: "auto", instructions: "Help." },
				b: { model: "auto", instructions: "Help." },
			},
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts external Agent references and rejects duplicate external ids", () => {
		const base = {
			version: "1",
			providers: { qoder: {} },
			agents: {
				lead: {
					model: "auto",
					instructions: "Help.",
					multiagent: { type: "coordinator", agents: [{ agent_id: "agent_external_1" }] },
				},
			},
		};
		expect(projectConfigSchema.safeParse(base).success).toBe(true);
		expect(
			projectConfigSchema.safeParse({
				...base,
				agents: {
					lead: {
						...base.agents.lead,
						multiagent: {
							type: "coordinator",
							agents: [{ agent_id: "agent_external_1" }, { agent_id: "agent_external_1" }],
						},
					},
				},
			}).success,
		).toBe(false);
	});

	test("accepts a roster with 20 members at the common schema level", () => {
		const members = memberNames(20);
		const agents: Record<string, AgentDecl> = { lead: agent({ multiagent: roster(...members) }) };
		for (const member of members) agents[member] = agent();
		const parsed = projectConfigSchema.safeParse({
			version: "1",
			providers: { qoder: {} },
			agents,
		});
		expect(parsed.success).toBe(true);
	});

	test("enforces the 20-member cap in provider-aware validation for qoder", () => {
		const members = memberNames(21);
		const agents: Record<string, AgentDecl> = { lead: agent({ multiagent: roster(...members) }) };
		for (const member of members) agents[member] = agent();
		const diagnostics = validateProjectConfig(multiagentConfig(agents));
		expect(codes(diagnostics)).toContain("qoder.agent.multiagent.member_limit");
	});

	test("enforces the 20-member cap in provider-aware validation for bailian", () => {
		const members = memberNames(21);
		const agents: Record<string, AgentDecl> = { lead: agent({ multiagent: roster(...members) }) };
		for (const member of members) agents[member] = agent();
		const diagnostics = validateProjectConfig(multiagentConfig(agents, { bailian: {} }));
		expect(codes(diagnostics)).toContain("bailian.agent.multiagent.member_limit");
	});

	test("does not impose the 20-member cap on providers without such a limit", () => {
		const members = memberNames(21);
		const agents: Record<string, AgentDecl> = { lead: agent({ multiagent: roster(...members) }) };
		for (const member of members) agents[member] = agent();
		const diagnostics = validateProjectConfig(multiagentConfig(agents, { claude: {} }));
		expect(codes(diagnostics)).not.toContain("qoder.agent.multiagent.member_limit");
		expect(codes(diagnostics)).not.toContain("bailian.agent.multiagent.member_limit");
	});
});

describe("multiagent materialization matching", () => {
	function forwardConfig(members: string[]): ProjectConfig {
		const agents: Record<string, AgentDecl> = {
			lead: agent({
				environment: "dev",
				delivery: { qoder: { type: "forward" } },
				multiagent: roster(...members),
			}),
		};
		for (const member of members) {
			agents[member] = agent({
				environment: "dev",
				delivery: { qoder: { type: "forward" } },
			});
		}
		return {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder" },
			environments: { dev: { config: { type: "cloud" } } },
			agents,
		};
	}

	test("accepts a Forward coordinator referencing Forward members", () => {
		const diagnostics = validateProjectConfig(forwardConfig(["reviewer", "writer"]));
		expect(codes(diagnostics)).not.toContain("qoder.template.multiagent.unsupported");
		expect(codes(diagnostics)).not.toContain("qoder.template.multiagent.member_materialization");
	});

	test("rejects an external Managed Agent reference on Qoder Forward", () => {
		const config = forwardConfig([]);
		config.agents!.lead!.multiagent = { type: "coordinator", agents: [{ agent_id: "agent_external_1" }] };
		const diagnostics = validateProjectConfig(config);
		expect(codes(diagnostics)).toContain("qoder.template.multiagent.external_member");
	});

	test("accepts an external Managed Agent reference on Qoder Managed", () => {
		const diagnostics = validateProjectConfig(
			multiagentConfig({
				lead: agent({ multiagent: { type: "coordinator", agents: [{ agent_id: "agent_external_1" }] } }),
			}),
		);
		expect(codes(diagnostics)).not.toContain("qoder.template.multiagent.external_member");
	});

	test("rejects a Forward coordinator referencing a Managed member", () => {
		const config = forwardConfig(["reviewer"]);
		config.agents!.reviewer = agent({ environment: "dev" });
		const diagnostics = validateProjectConfig(config);
		expect(codes(diagnostics)).toContain("qoder.template.multiagent.member_materialization");
		expect(codes(diagnostics)).not.toContain("qoder.template.multiagent.unsupported");
	});

	test("rejects a Managed coordinator referencing a Forward member", () => {
		const config: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder" },
			environments: { dev: { config: { type: "cloud" } } },
			agents: {
				lead: agent({ multiagent: roster("reviewer") }),
				reviewer: agent({ environment: "dev", delivery: { qoder: { type: "forward" } } }),
			},
		};
		const diagnostics = validateProjectConfig(config);
		expect(codes(diagnostics)).toContain("qoder.template.multiagent.member_materialization");
	});

	test("keeps the reference-only pipeline free of provider materialization rules", () => {
		const config = forwardConfig(["reviewer"]);
		config.agents!.reviewer = agent({ environment: "dev" });
		const diagnostics = collectConfigReferences(config);
		expect(codes(diagnostics)).not.toContain("qoder.template.multiagent.member_materialization");
	});
});

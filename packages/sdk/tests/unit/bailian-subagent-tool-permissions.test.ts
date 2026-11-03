import { describe, expect, test } from "bun:test";
import { collectConfigReferences, validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { AgentDecl, AgentToolsDecl, ProjectConfig } from "../../src/internal/types/config.ts";

function configuration(tools: AgentToolsDecl, self = false): ProjectConfig {
	const member: AgentDecl = { model: "auto", instructions: "Worker", tools };
	return {
		version: "1",
		providers: { bailian: {}, qoder: {} },
		defaults: { provider: "bailian" },
		agents: {
			lead: {
				model: "auto",
				instructions: "Coordinator",
				...(self ? { tools } : {}),
				multiagent: { type: "coordinator", agents: self ? [{ type: "self" }] : ["worker"] },
			},
			...(!self ? { worker: member } : {}),
		},
	};
}

describe("百炼子 Agent 的有效工具审批校验", () => {
	test.each([
		{ builtin: ["bash"], default_permission: "ask" },
		{ builtin: ["bash"], permissions: { Bash: "ask" } },
	] satisfies AgentToolsDecl[])("拒绝成员工具的有效 ask 策略：%j", (tools) => {
		const diagnostics = validateProjectConfig(configuration(tools));
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "bailian.agent.multiagent.tool_permissions.unsupported",
				resource: { type: "agent", name: "lead", provider: "bailian" },
			}),
		);
		expect(diagnostics.find((item) => item.code.includes("multiagent.tool_permissions"))?.message).toContain("worker");
	});

	test("Self 作为子 Agent 委派时同样拒绝有效 ask", () => {
		const diagnostics = validateProjectConfig(configuration({ builtin: ["bash"], default_permission: "ask" }, true));
		expect(diagnostics.map((item) => item.code)).toContain("bailian.agent.multiagent.tool_permissions.unsupported");
	});

	test.each([
		{ builtin: ["bash"], default_permission: "ask", permissions: { Bash: "allow" } },
		{ builtin: [], default_permission: "ask" },
		{ builtin: ["bash"] },
	] satisfies AgentToolsDecl[])("允许实际不需审批的成员：%j", (tools) => {
		expect(validateProjectConfig(configuration(tools))).toEqual([]);
	});

	test("主 Agent 可审批，Provider 过滤与仅引用校验保持独立", () => {
		const config = configuration({ builtin: ["bash"], permissions: { bash: "ask" } });
		expect(validateProjectConfig(config, { providers: ["qoder"] })).toEqual([]);
		expect(collectConfigReferences(config)).toEqual([]);
		config.agents!.lead!.multiagent = undefined;
		expect(validateProjectConfig(config)).toEqual([]);
	});

	test("plan 对实际存在的成员生成阻断诊断", async () => {
		const config = configuration({ builtin: ["bash"], permissions: { bash: "ask" } });
		const plan = await buildPlan(config, { resources: [] });
		expect(plan.actions.map((action) => action.address.name).sort()).toEqual(["lead", "worker"]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "bailian.agent.multiagent.tool_permissions.unsupported" }),
		);
	});
});

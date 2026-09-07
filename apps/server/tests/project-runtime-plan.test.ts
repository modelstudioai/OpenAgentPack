import { describe, expect, test } from "bun:test";
import type { Diagnostic, PlannedAction } from "@openagentpack/sdk";
import { scopeProjectRuntimePlan } from "@/services/project-runtime-plan";

describe("project runtime plan scope", () => {
	test("keeps the complete Publish action set including Deployment and Channel", () => {
		const actions = [
			action("template", "create", "assistant"),
			action("vault", "update", "secrets"),
			action("agent", "delete", "retired"),
			action("identity", "no-op", "runtime-identity"),
			action("deployment", "delete", "daily"),
			action("channel", "create", "chat"),
		];
		const diagnostics: Diagnostic[] = [
			{ severity: "warning", code: "global", message: "global warning" },
			{
				severity: "error",
				code: "deployment.error",
				message: "deployment error",
				resource: { type: "deployment", name: "daily", provider: "qoder" },
			},
			{
				severity: "warning",
				code: "agent.warning",
				message: "agent warning",
				resource: { type: "agent", name: "assistant", provider: "qoder" },
			},
		];

		const plan = scopeProjectRuntimePlan(actions, diagnostics);

		expect(plan.actions.map((entry) => [entry.address.type, entry.action])).toEqual([
			["template", "create"],
			["vault", "update"],
			["agent", "delete"],
			["identity", "no-op"],
			["deployment", "delete"],
			["channel", "create"],
		]);
		expect(plan.destructiveActions.map((entry) => entry.address.name)).toEqual(["retired", "daily"]);
		expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"global",
			"deployment.error",
			"agent.warning",
		]);
		expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("fingerprints the exact scoped action set used by Apply", () => {
		const original = scopeProjectRuntimePlan([action("agent", "update", "assistant")], []);
		const changed = scopeProjectRuntimePlan([action("agent", "delete", "assistant")], []);
		const deploymentChange = scopeProjectRuntimePlan(
			[action("agent", "update", "assistant"), action("deployment", "delete", "daily")],
			[],
		);

		expect(changed.fingerprint).not.toBe(original.fingerprint);
		expect(deploymentChange.fingerprint).not.toBe(original.fingerprint);
	});
});

function action(
	type: PlannedAction["address"]["type"],
	actionKind: PlannedAction["action"],
	name: string,
): PlannedAction {
	return {
		action: actionKind,
		address: { type, name, provider: "qoder" },
		reason: `${actionKind} ${type}`,
		dependencies: [],
	};
}

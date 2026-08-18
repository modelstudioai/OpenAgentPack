import { expect, test } from "bun:test";
import type { PlannedAction } from "@openagentpack/sdk";
import { comparePlanActions } from "./plan-impact";

test("comparePlanActions separates the edited resource from unchanged pending creates", () => {
	const environment = createAction("environment", "dev", "environment-hash");
	const beforeAgent = createAction("agent", "researcher", "agent-before");
	const afterAgent = createAction("agent", "researcher", "agent-after");

	const impact = comparePlanActions([environment, beforeAgent], [environment, afterAgent]);

	expect(impact.currentEdit.map(resourceName)).toEqual(["agent.researcher"]);
	expect(impact.alreadyPending.map(resourceName)).toEqual(["environment.dev"]);
	expect(impact.resolvedByEdit).toEqual([]);
});

test("comparePlanActions reports pending actions cleared by an edit", () => {
	const removedCreate = createAction("skill", "unused", "skill-hash");
	const noOp = { ...createAction("environment", "dev", "environment-hash"), action: "no-op" as const };

	const impact = comparePlanActions([removedCreate, noOp], [noOp]);

	expect(impact.currentEdit).toEqual([]);
	expect(impact.alreadyPending).toEqual([]);
	expect(impact.resolvedByEdit.map(resourceName)).toEqual(["skill.unused"]);
});

function createAction(type: PlannedAction["address"]["type"], name: string, contentHash: string): PlannedAction {
	return {
		action: "create",
		address: { type, name, provider: "bailian" },
		reason: "Resource does not exist in state",
		after: { content_hash: contentHash },
		dependencies: [],
	};
}

function resourceName(action: PlannedAction): string {
	return `${action.address.type}.${action.address.name}`;
}

import { expect, test } from "bun:test";
import type { PlannedAction } from "@openagentpack/sdk";
import { assertCiApplyPolicy } from "../../src/commands/apply.ts";

function action(overrides: Partial<PlannedAction> = {}): PlannedAction {
	return {
		action: "update",
		address: { type: "agent", name: "assistant", provider: "bailian" },
		reason: "test action",
		driftKind: "local",
		dependencies: [],
		...overrides,
	};
}

test("CI apply policy allows non-destructive local changes", () => {
	expect(() => assertCiApplyPolicy([action({ action: "create" }), action()])).not.toThrow();
});

test("CI apply policy blocks deletes", () => {
	expect(() => assertCiApplyPolicy([action({ action: "delete", driftKind: "none" })])).toThrow(
		"CI policy blocked 1 delete action",
	);
});

test("CI apply policy blocks remote and combined drift", () => {
	expect(() => assertCiApplyPolicy([action({ driftKind: "remote" }), action({ driftKind: "both" })])).toThrow(
		"CI policy blocked 2 action(s) with remote drift",
	);
});

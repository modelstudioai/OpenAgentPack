import { describe, expect, test } from "bun:test";
import {
	buildReadinessBaseline,
	classifyReadinessImpact,
	diffChangedPaths,
	diffReadinessBaseline,
} from "../../src/internal/planner/plan-semantics.ts";

describe("plan semantics", () => {
	test("reason-independent impact keeps descriptive fields non-blocking", () => {
		expect(classifyReadinessImpact("update", ["description", "metadata.owner"])).toBe("non_blocking");
		expect(classifyReadinessImpact("update", ["description", "model"])).toBe("blocking");
		expect(classifyReadinessImpact("create", ["description"])).toBe("blocking");
	});

	test("builds an irreversible readiness baseline without retaining declaration values", () => {
		const baseline = buildReadinessBaseline({
			description: "public label",
			metadata: { owner: "team" },
			credentials: { token: "must-not-enter-state" },
		});

		expect(Object.values(baseline).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
		expect(JSON.stringify(baseline)).not.toContain("must-not-enter-state");
		expect(JSON.stringify(baseline)).not.toContain("public label");
	});

	test("derives local change facets from hashed baselines", () => {
		const before = buildReadinessBaseline({ description: "old", metadata: { owner: "a" }, model: "m1" });
		const descriptive = buildReadinessBaseline({ description: "new", metadata: { owner: "a" }, model: "m1" });
		const operational = buildReadinessBaseline({ description: "old", metadata: { owner: "a" }, model: "m2" });

		expect(diffReadinessBaseline(before, descriptive)).toEqual(["description"]);
		expect(diffReadinessBaseline(before, operational)).toEqual(["$operational"]);
	});

	test("derives stable remote paths independent of object key order", () => {
		expect(diffChangedPaths({ metadata: { a: 1, b: 2 } }, { metadata: { b: 2, a: 1 } })).toEqual([]);
		expect(diffChangedPaths({ metadata: { a: 1 } }, { metadata: { a: 2 } })).toEqual(["metadata.a"]);
	});
});

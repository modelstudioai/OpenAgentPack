import { describe, expect, test } from "bun:test";
import { requiresMaintainerEvidence, validateMaintainerEvidence } from "./pr-evidence.ts";

describe("pull-request maintainer evidence", () => {
	test("does not add a merge barrier for ordinary contribution paths", () => {
		expect(requiresMaintainerEvidence(["README.md", "packages/cli/src/program.ts", "bun.lock"])).toBe(false);
		expect(validateMaintainerEvidence("", ["README.md"])).toBeUndefined();
	});

	test("uses PR evidence instead of commit-message markers for control-plane changes", () => {
		const files = [".github/workflows/ci.yml", "scripts/verify.ts"];
		expect(requiresMaintainerEvidence(files)).toBe(true);
		expect(validateMaintainerEvidence("## Summary\nAdjust CI", files)).toContain("## Behavior / risk");
	});

	test("treats package manifests, but not the generated lockfile alone, as high risk", () => {
		expect(requiresMaintainerEvidence(["packages/sdk/package.json"])).toBe(true);
		expect(requiresMaintainerEvidence(["bun.lock"])).toBe(false);
	});

	test("asks for behavior and validation evidence on high-risk paths", () => {
		const files = ["packages/sdk/src/internal/providers/interface.ts"];
		expect(requiresMaintainerEvidence(files)).toBe(true);
		expect(validateMaintainerEvidence("## Summary\nA change", files)).toContain("## Behavior / risk");
	});

	test("accepts concrete evidence for high-risk changes", () => {
		const body = `## Summary
Add a provider capability.

## Behavior / risk

Existing provider configuration remains unchanged; the new capability is opt-in.

## Validation

\`bun test packages/sdk/tests/unit/provider-conformance.test.ts\``;
		expect(validateMaintainerEvidence(body, [".github/workflows/release.yml"])).toBeUndefined();
	});

	test("does not treat HTML comments as evidence", () => {
		const body = `## Behavior / risk
<!--

## Validation
<!--`;
		expect(validateMaintainerEvidence(body, [".github/workflows/release.yml"])).toContain("## Behavior / risk");
	});
});

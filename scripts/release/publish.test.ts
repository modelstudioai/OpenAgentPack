import { describe, expect, test } from "bun:test";
import {
	assertPublishEnvironment,
	inferDistTag,
	publishedPackageSpec,
	publishedVersionMatches,
	shouldSkipPublishedVersion,
} from "./publish.ts";

describe("release publish recovery", () => {
	test("uses an exact package version when querying npm", () => {
		expect(publishedPackageSpec("@openagentpack/sdk", "1.2.3-beta.4")).toBe("@openagentpack/sdk@1.2.3-beta.4");
	});

	test("recognizes npm view JSON output", () => {
		expect(publishedVersionMatches('"1.2.3"', "1.2.3")).toBe(true);
		expect(publishedVersionMatches('["1.2.3"]', "1.2.3")).toBe(true);
		expect(publishedVersionMatches('"1.2.2"', "1.2.3")).toBe(false);
		expect(publishedVersionMatches("not-json", "1.2.3")).toBe(false);
	});

	test("skips existing versions only during a real publish", () => {
		expect(shouldSkipPublishedVersion(false, true)).toBe(true);
		expect(shouldSkipPublishedVersion(true, true)).toBe(false);
		expect(shouldSkipPublishedVersion(false, false)).toBe(false);
	});

	test("derives a safe npm dist-tag from prerelease versions", () => {
		expect(inferDistTag("1.0.1-beta.5")).toBe("beta");
		expect(inferDistTag("2.0.0-rc.1")).toBe("rc");
		expect(inferDistTag("1.0.1")).toBeUndefined();
	});

	test("allows real publishing only inside GitHub Actions", () => {
		const workflow = {
			GITHUB_ACTIONS: "true",
			GITHUB_WORKFLOW: "Publish npm",
			GITHUB_EVENT_NAME: "workflow_dispatch",
		};
		expect(() => assertPublishEnvironment(false, {})).toThrow("GitHub Actions");
		expect(() => assertPublishEnvironment(false, { ...workflow, GITHUB_WORKFLOW: "CI" })).toThrow("GitHub Actions");
		expect(() => assertPublishEnvironment(false, workflow)).not.toThrow();
		expect(() => assertPublishEnvironment(true, {})).not.toThrow();
	});
});

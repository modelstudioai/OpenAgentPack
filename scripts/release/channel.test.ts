import { describe, expect, test } from "bun:test";
import { commonReleaseVersion, validateReleaseIdentity } from "./channel.ts";

describe("release channel guard", () => {
	test("accepts stable versions only on main", () => {
		expect(validateReleaseIdentity("stable", "main", "1.2.3")).toEqual({
			channel: "stable",
			version: "1.2.3",
			distTag: "latest",
		});
		expect(() => validateReleaseIdentity("stable", "release/1.2.3-beta", "1.2.3")).toThrow("main");
		expect(() => validateReleaseIdentity("stable", "main", "1.2.3-beta.0")).toThrow("X.Y.Z");
	});

	test("binds beta versions to their isolated release branch", () => {
		expect(validateReleaseIdentity("beta", "release/1.2.3-beta", "1.2.3-beta.4", "1.2.3")).toEqual({
			channel: "beta",
			version: "1.2.3-beta.4",
			distTag: "beta",
		});
		expect(() => validateReleaseIdentity("beta", "main", "1.2.3-beta.0")).toThrow("release/X.Y.Z-beta");
		expect(() => validateReleaseIdentity("beta", "release/1.2.3-beta", "1.2.4-beta.0")).toThrow("1.2.3-beta.N");
		expect(() => validateReleaseIdentity("beta", "release/1.2.3-beta", "1.2.3-beta.0", "2.0.0")).toThrow(
			"does not match",
		);
	});

	test("requires all fixed-group package versions to match", () => {
		expect(commonReleaseVersion(["1.0.0", "1.0.0", "1.0.0"])).toBe("1.0.0");
		expect(() => commonReleaseVersion(["1.0.0", "1.0.1"])).toThrow("must match");
		expect(() => commonReleaseVersion([])).toThrow("no release package versions");
	});
});

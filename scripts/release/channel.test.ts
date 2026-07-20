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

	test("accepts deterministic beta snapshots only on main", () => {
		expect(validateReleaseIdentity("beta", "main", "0.0.0-beta.run-123456789.sha-a1b2c3d")).toEqual({
			channel: "beta",
			version: "0.0.0-beta.run-123456789.sha-a1b2c3d",
			distTag: "beta",
		});
		expect(() => validateReleaseIdentity("beta", "feature/test", "0.0.0-beta.run-123456789.sha-a1b2c3d")).toThrow(
			"main",
		);
		expect(() => validateReleaseIdentity("beta", "main", "1.2.3-beta.0")).toThrow("unexpected format");
	});

	test("requires all fixed-group package versions to match", () => {
		expect(commonReleaseVersion(["1.0.0", "1.0.0", "1.0.0"])).toBe("1.0.0");
		expect(() => commonReleaseVersion(["1.0.0", "1.0.1"])).toThrow("must match");
		expect(() => commonReleaseVersion([])).toThrow("no release package versions");
	});
});

import { describe, expect, test } from "bun:test";
import { isSdkOnly, packedFilename, smokePackages } from "./smoke-packed.ts";

describe("npm pack output", () => {
	test("accepts the npm 10 and 11 array format", () => {
		expect(packedFilename('[{"filename":"sdk.tgz"}]', "sdk")).toBe("sdk.tgz");
	});

	test("accepts the npm 12 package-map format", () => {
		expect(packedFilename('{"@openagentpack/sdk":{"filename":"sdk.tgz"}}', "sdk")).toBe("sdk.tgz");
	});

	test("rejects ambiguous output", () => {
		expect(() => packedFilename("[]", "sdk")).toThrow("Unexpected npm pack output for sdk");
	});
});

describe("--sdk-only mode", () => {
	test("detects the flag among CLI arguments", () => {
		expect(isSdkOnly(["--sdk-only"])).toBe(true);
		expect(isSdkOnly([])).toBe(false);
		expect(isSdkOnly(["--verbose"])).toBe(false);
	});

	test("restricts the package set to sdk when enabled", () => {
		expect(smokePackages(true)).toEqual(["sdk"]);
	});

	test("keeps the full package set when disabled", () => {
		expect(smokePackages(false)).toEqual(["sdk", "playground", "cli"]);
	});
});

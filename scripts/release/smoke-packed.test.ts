import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

	test("restricts the package set to Node 18-compatible libraries when enabled", () => {
		expect(smokePackages(true)).toEqual(["sdk", "project-versions", "project-workspace"]);
	});

	test("CI builds every library in dependency order before the SDK-only smoke", () => {
		const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
		const sdkStep = workflow.match(/ {6}- if: matrix\.scope == 'sdk'\n {8}run: \|\n((?: {10}.*\n)+)/);
		expect(sdkStep).not.toBeNull();
		const commands = sdkStep?.[1]
			.trim()
			.split("\n")
			.map((line) => line.trim());
		expect(commands).toEqual([
			...smokePackages(true).map((pkg) => `bun run build:${pkg}`),
			"bun scripts/release/smoke-packed.ts --sdk-only",
		]);
	});

	test("keeps the full package set when disabled", () => {
		expect(smokePackages(false)).toEqual(["sdk", "project-versions", "project-workspace", "playground", "cli"]);
	});
});

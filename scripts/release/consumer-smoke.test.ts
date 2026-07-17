import { describe, expect, test } from "bun:test";
import { commonRegistryVersion, packageName, registryVersion } from "./consumer-smoke.ts";

describe("published consumer smoke", () => {
	test("builds canonical package names", () => {
		expect(packageName("sdk")).toBe("@openagentpack/sdk");
	});

	test("reads an exact registry version", () => {
		expect(registryVersion('"1.2.3"', "@openagentpack/sdk")).toBe("1.2.3");
		expect(() => registryVersion("[]", "@openagentpack/sdk")).toThrow("invalid version");
	});

	test("requires the fixed release group to resolve one version", () => {
		expect(
			commonRegistryVersion([
				{ name: "@openagentpack/sdk", version: "1.2.3" },
				{ name: "@openagentpack/cli", version: "1.2.3" },
			]),
		).toBe("1.2.3");
		expect(() =>
			commonRegistryVersion([
				{ name: "@openagentpack/sdk", version: "1.2.3" },
				{ name: "@openagentpack/cli", version: "1.2.4" },
			]),
		).toThrow("versions must match");
	});
});

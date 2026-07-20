import { describe, expect, test } from "bun:test";
import { commonRegistryVersion, packageName, registryVersion, waitForRegistry } from "./consumer-smoke.ts";

describe("published consumer smoke", () => {
	test("builds canonical package names", () => {
		expect(packageName("sdk")).toBe("@openagentpack/sdk");
	});

	test("reads an exact registry version", () => {
		expect(registryVersion('"1.2.3"', "@openagentpack/sdk")).toBe("1.2.3");
		expect(registryVersion('["1.2.3"]', "@openagentpack/sdk")).toBe("1.2.3");
		const invalidVersion = () => registryVersion("[]", "@openagentpack/sdk");
		expect(invalidVersion).toThrow("invalid version for @openagentpack/sdk");
		expect(invalidVersion).toThrow("received: []");
		expect(() => registryVersion('["1.2.3","1.2.4"]', "@openagentpack/sdk")).toThrow("invalid version");
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

	test("waits through transient registry propagation", async () => {
		let queries = 0;
		const delays: number[] = [];
		const version = await waitForRegistry(
			"1.2.3",
			{ attempts: 3, delayMs: 25 },
			{
				resolve: () => {
					queries++;
					if (queries < 3) throw new Error("@openagentpack/sdk is not visible yet");
					return "1.2.3";
				},
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
				log: () => {},
			},
		);

		expect(version).toBe("1.2.3");
		expect(queries).toBe(3);
		expect(delays).toEqual([25, 25]);
	});

	test("reports the transient registry error while waiting", async () => {
		let queries = 0;
		const messages: string[] = [];
		await waitForRegistry(
			"1.2.3",
			{ attempts: 2, delayMs: 0 },
			{
				resolve: () => {
					queries++;
					if (queries === 1) throw new Error("@openagentpack/sdk returned []");
					return "1.2.3";
				},
				sleep: async () => {},
				log: (message) => messages.push(message),
			},
		);

		expect(messages[0]).toContain("@openagentpack/sdk returned []");
	});

	test("allows fifteen minutes for registry propagation by default", async () => {
		let queries = 0;
		let delays = 0;
		const waiting = waitForRegistry(
			"1.2.3",
			{},
			{
				resolve: () => {
					queries++;
					throw new Error("not visible");
				},
				sleep: async () => {
					delays++;
				},
				log: () => {},
			},
		);

		await expect(waiting).rejects.toThrow("not visible");
		expect(queries).toBe(90);
		expect(delays).toBe(89);
	});
});

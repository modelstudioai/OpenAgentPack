import { describe, expect, test } from "bun:test";
import { listProviderDiscovery, listProviderNames } from "../../src/internal/core/models-runtime.ts";
import "../../src/internal/providers/all.ts";

describe("provider discovery runtime", () => {
	test("lists provider names through a service-level API", () => {
		expect(listProviderNames()).toEqual(expect.arrayContaining(["ark", "bailian", "claude", "qoder"]));
	});

	test("returns capabilities without registry mutation APIs", () => {
		const qoder = listProviderDiscovery().find((provider) => provider.name === "qoder");

		expect(qoder?.capabilities.session.tier).toBe("native");
		expect(qoder).not.toHaveProperty("createAdapter");
		expect(qoder).not.toHaveProperty("configSchema");
	});
});

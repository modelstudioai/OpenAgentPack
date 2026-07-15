import { describe, expect, test } from "bun:test";
import {
	arkEnvironmentWireNameAttempt,
	normalizeWireResourceName,
} from "../../src/internal/providers/resource-naming.ts";

describe("normalizeWireResourceName", () => {
	test("passes through names for providers without explicit rules", () => {
		expect(normalizeWireResourceName("qoder", "environment", "Agents/base")).toBe("Agents/base");
		expect(normalizeWireResourceName("bailian", "environment", "Agents/base")).toBe("Agents/base");
	});

	test("normalizes Ark environment name to provider regex", () => {
		expect(normalizeWireResourceName("ark", "environment", "Agents/base")).toBe("agents-base");
		expect(normalizeWireResourceName("ark", "environment", "___中文___")).toBe("env");
		expect(normalizeWireResourceName("ark", "environment", "ab")).toBe("ab-env");
	});

	test("does not apply Ark environment rule to other resource kinds", () => {
		expect(normalizeWireResourceName("ark", "agent", "Agents/base")).toBe("Agents/base");
	});

	test("arkEnvironmentWireNameAttempt appends incrementing suffix on conflict retries", () => {
		expect(arkEnvironmentWireNameAttempt("agents-base", 0)).toBe("agents-base");
		expect(arkEnvironmentWireNameAttempt("agents-base", 1)).toBe("agents-base-1");
		expect(arkEnvironmentWireNameAttempt("agents-base", 2)).toBe("agents-base-2");
	});
});

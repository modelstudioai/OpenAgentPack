import { describe, expect, test } from "bun:test";
import {
	canonicalToolName,
	permissionOverridesFromWire,
	resolveBuiltinTools,
	toPermissionPolicy,
} from "../../src/internal/utils/tool-permissions.ts";

describe("tool permission resolution", () => {
	test("defaults every enabled tool to allow", () => {
		expect(resolveBuiltinTools({ builtin: ["Read", "Bash"] })).toEqual([
			{ configuredName: "Read", wireName: "Read", permission: "allow" },
			{ configuredName: "Bash", wireName: "Bash", permission: "allow" },
		]);
	});

	test("matches permission overrides without case or separator sensitivity", () => {
		const resolved = resolveBuiltinTools({
			builtin: ["WebSearch", "Bash"],
			default_permission: "ask",
			permissions: { web_search: "allow", bash: "allow" },
		});
		expect(resolved.map((tool) => tool.permission)).toEqual(["allow", "allow"]);
		expect(canonicalToolName(" Web-Search ")).toBe("websearch");
	});

	test("maps generic permissions to provider wire policies", () => {
		expect(toPermissionPolicy("allow")).toEqual({ type: "always_allow" });
		expect(toPermissionPolicy("ask")).toEqual({ type: "always_ask" });
	});

	test("preserves allow and ask policies when reverse-mapping provider configs", () => {
		expect(
			permissionOverridesFromWire([
				{ name: "Read", enabled: true, permission_policy: { type: "always_allow" } },
				{ name: "Bash", enabled: true, permission_policy: { type: "always_ask" } },
			]),
		).toEqual({ Read: "allow", Bash: "ask" });
	});
});

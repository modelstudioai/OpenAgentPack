import { describe, expect, test } from "bun:test";
import { resolveSyncProvider } from "../../src/internal/core/sync-runtime.ts";
import { UserError } from "../../src/internal/errors.ts";

describe("resolveSyncProvider", () => {
	test("prefers explicit --provider", () => {
		expect(
			resolveSyncProvider(
				{
					providers: { claude: {}, bailian: {} },
					defaults: { provider: "bailian" },
				},
				"claude",
			),
		).toBe("claude");
	});

	test("uses defaults.provider when set to a single provider", () => {
		expect(
			resolveSyncProvider({
				providers: { claude: {}, bailian: {} },
				defaults: { provider: "bailian" },
			}),
		).toBe("bailian");
	});

	test("uses sole providers key when defaults is missing", () => {
		expect(
			resolveSyncProvider({
				providers: { claude: {} },
			}),
		).toBe("claude");
	});

	test("rejects defaults.provider=all without explicit provider", () => {
		expect(() =>
			resolveSyncProvider({
				providers: { claude: {}, bailian: {} },
				defaults: { provider: "all" },
			}),
		).toThrow(UserError);
	});

	test("rejects ambiguous multi-provider config without explicit provider", () => {
		expect(() =>
			resolveSyncProvider({
				providers: { claude: {}, bailian: {} },
			}),
		).toThrow(/Pass --provider/);
	});
});

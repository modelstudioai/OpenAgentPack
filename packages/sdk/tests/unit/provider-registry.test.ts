import { expect, test } from "bun:test";
import { placeholderProviderConfig } from "../../src/internal/providers/registry.ts";

// Placeholder values are literal "${ENV_VAR}" tokens; assert their shape with a
// regex instead of literal strings so biome's noTemplateCurlyInString rule (which
// guards against accidental template placeholders) stays happy.
const PLACEHOLDER_RE = /^\$\{[A-Z_]+\}$/;

// `agents sync` falls back to these placeholders when the source providers block
// is unavailable. bailian must emit base_url (its preferred field) so the emitted
// config is valid without a workspace_id.
test("placeholderProviderConfig emits api_key + base_url for bailian, not workspace_id", () => {
	const block = placeholderProviderConfig("bailian");
	expect(Object.keys(block).sort()).toEqual(["api_key", "base_url"]);
	expect(block.workspace_id).toBeUndefined();
	for (const value of Object.values(block)) {
		expect(value).toMatch(PLACEHOLDER_RE);
	}
});

test("placeholderProviderConfig emits only required fields for other providers", () => {
	expect(Object.keys(placeholderProviderConfig("claude"))).toEqual(["api_key"]);
	expect(Object.keys(placeholderProviderConfig("ark"))).toEqual(["api_key"]);
});

test("placeholderProviderConfig returns empty for an unknown provider", () => {
	expect(placeholderProviderConfig("nope")).toEqual({});
});

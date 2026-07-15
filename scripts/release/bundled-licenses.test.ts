import { describe, expect, test } from "bun:test";
import { collectWebBundleLicenses, renderWebBundleLicenses } from "./bundled-licenses.ts";

describe("bundled WebUI licenses", () => {
	test("collects license texts for the production dependency closure", () => {
		const licenses = collectWebBundleLicenses();
		const names = new Set(licenses.map((entry) => entry.name));
		expect(names).toContain("react");
		expect(names).toContain("lucide-react");
		expect(names).toContain("@tiptap/core");
		expect(licenses.every((entry) => entry.license && entry.texts.length > 0)).toBe(true);
	});

	test("renders a deterministic notice document", () => {
		const rendered = renderWebBundleLicenses();
		expect(rendered).toStartWith("# Bundled WebUI Third-Party Licenses");
		expect(rendered).toContain("## react@");
		expect(rendered).toContain("```text\nMIT License");
	});
});

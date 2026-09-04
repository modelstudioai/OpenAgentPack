import { describe, expect, test } from "bun:test";
import { mergeAttributes } from "@tiptap/core";

describe("Tiptap attribute safety", () => {
	test("does not inherit attributes from a JSON-origin __proto__ key", () => {
		// Regression for GHSA-cp6q-959q-f8rh; use an inert marker instead of executable attributes.
		const untrustedAttributes = JSON.parse('{"__proto__":{"data-inherited":"unexpected"},"title":"file"}');
		const attributes = mergeAttributes({ class: "mention-tag" }, untrustedAttributes);

		expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
		expect("data-inherited" in attributes).toBe(false);
		expect(attributes.class).toBe("mention-tag");
		expect(attributes.title).toBe("file");
	});

	test("continues merging ordinary mention classes and attributes", () => {
		const attributes = mergeAttributes(
			{ class: "mention-tag", "data-type": "mention", title: "previous" },
			{ class: "selected", "data-id": "file_1", title: "current" },
		);

		expect(attributes).toEqual({
			class: "mention-tag selected",
			"data-type": "mention",
			"data-id": "file_1",
			title: "current",
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOCALE,
	FALLBACK_LOCALE,
	getPlaybookDisplayName,
	listPlaybookCards,
	resolveLocalized,
} from "../src/index.ts";

describe("resolveLocalized — fallback chain (active → en → any → id)", () => {
	test("returns the active-locale value when present", () => {
		expect(resolveLocalized({ zh: "设计师", en: "Designer" }, "zh", "designer")).toBe("设计师");
	});

	test("falls back to en when the active locale is absent", () => {
		expect(resolveLocalized({ en: "Designer", fr: "Concepteur" }, "zh", "designer")).toBe("Designer");
	});

	test("falls back to any value when neither active nor en exist", () => {
		expect(resolveLocalized({ fr: "Concepteur" }, "zh", "designer")).toBe("Concepteur");
	});

	test("falls back to the id when the map is empty or undefined", () => {
		expect(resolveLocalized({}, "zh", "designer")).toBe("designer");
		expect(resolveLocalized(undefined, "zh", "designer")).toBe("designer");
	});

	test("FALLBACK_LOCALE is en and DEFAULT_LOCALE is zh", () => {
		expect(FALLBACK_LOCALE).toBe("en");
		expect(DEFAULT_LOCALE).toBe("zh");
	});
});

describe("catalog accessors — locale wiring", () => {
	test("getPlaybookDisplayName resolves zh by default and en when asked", () => {
		expect(getPlaybookDisplayName("designer")).toBe("网页设计");
		expect(getPlaybookDisplayName("designer", "en")).toBe("Brand Web Designer");
	});

	test("getPlaybookDisplayName falls back to the id for an unknown playbook", () => {
		expect(getPlaybookDisplayName("not-a-playbook")).toBe("not-a-playbook");
	});

	test("listPlaybookCards localizes title/prompt and carries the id", () => {
		const cards = listPlaybookCards("en");
		const designer = cards.find((c) => c.id === "designer");
		expect(designer?.title).toBe("Brand Web Designer");
		expect(designer?.playbookTemplateId).toBe("designer");
		expect(designer?.prompt).toBe(
			"Build a product landing page with editorial black-and-white style and soft color story blocks.",
		);

		const artDesigner = cards.find((c) => c.id === "art-designer");
		expect(artDesigner?.prompt).toBe("Generate a cyberpunk cat poster");
	});
});

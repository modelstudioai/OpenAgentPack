import { describe, expect, test } from "bun:test";
import { enUS, normalizeLanguage, zhCN } from "../src/i18n/resources";

function leafKeys(value: object, prefix = ""): string[] {
	return Object.entries(value).flatMap(([key, entry]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return typeof entry === "string" ? [path] : leafKeys(entry, path);
	});
}

describe("Workbench translations", () => {
	test("English and Chinese resources expose the same keys", () => {
		expect(leafKeys(zhCN).sort()).toEqual(leafKeys(enUS).sort());
	});

	test("normalizes browser language variants", () => {
		expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
		expect(normalizeLanguage("zh-Hans")).toBe("zh-CN");
		expect(normalizeLanguage("en-GB")).toBe("en-US");
		expect(normalizeLanguage(undefined)).toBe("en-US");
	});

	test("contains localized Workbench navigation and destructive actions", () => {
		expect(enUS.app.tabs.versions).toBe("Versions");
		expect(zhCN.app.tabs.versions).toBe("版本");
		expect(enUS.versions.restore).toBe("Restore to working tree");
		expect(zhCN.versions.restore).toBe("恢复到工作目录");
	});
});

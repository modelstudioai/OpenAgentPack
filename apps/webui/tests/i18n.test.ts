import { describe, expect, test } from "bun:test";
import { enUS, normalizeLanguage, zhCN } from "../src/i18n/resources";

function leafKeys(value: object, prefix = ""): string[] {
	return Object.entries(value).flatMap(([key, entry]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return typeof entry === "string" ? [path] : leafKeys(entry, path);
	});
}

function loadWorkbenchLanguage(storedLanguage: string | null, nextLanguage?: string) {
	const entryUrl = new URL("../src/i18n/index.ts", import.meta.url).href;
	// Isolate browser globals and the i18next singleton from other tests.
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"--eval",
			`
			const preferences = new Map([["openagentpack.workbench.language", ${JSON.stringify(storedLanguage)}]]);
			globalThis.window = {
				navigator: { language: "zh-CN" },
				localStorage: {
					getItem: (key) => preferences.get(key) ?? null,
					setItem: (key, value) => preferences.set(key, value),
				},
			};
			globalThis.document = { documentElement: { lang: "" } };
			const { i18n, LANGUAGE_STORAGE_KEY } = await import(${JSON.stringify(entryUrl)});
			const initialLanguage = i18n.resolvedLanguage;
			const nextLanguage = ${JSON.stringify(nextLanguage) ?? "undefined"};
			if (nextLanguage) await i18n.changeLanguage(nextLanguage);
			console.log(JSON.stringify({
				initialLanguage,
				language: i18n.resolvedLanguage,
				storedLanguage: preferences.get(LANGUAGE_STORAGE_KEY),
				documentLanguage: document.documentElement.lang,
			}));
			`,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "");
}

describe("Workbench translations", () => {
	test("defaults to English even when the browser language is Chinese", () => {
		expect(loadWorkbenchLanguage(null)).toEqual({
			initialLanguage: "en-US",
			language: "en-US",
			storedLanguage: "en-US",
			documentLanguage: "en-US",
		});
	});

	test("preserves an explicitly saved language preference", () => {
		expect(loadWorkbenchLanguage("zh-CN").initialLanguage).toBe("zh-CN");
		expect(loadWorkbenchLanguage("en-US").initialLanguage).toBe("en-US");
	});

	test("falls back to English for an unsupported saved language", () => {
		expect(loadWorkbenchLanguage("fr-FR").initialLanguage).toBe("en-US");
	});

	test("still switches languages and persists the user's selection", () => {
		expect(loadWorkbenchLanguage(null, "zh-CN")).toEqual({
			initialLanguage: "en-US",
			language: "zh-CN",
			storedLanguage: "zh-CN",
			documentLanguage: "zh-CN",
		});
	});

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

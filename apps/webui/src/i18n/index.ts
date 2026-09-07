import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { normalizeLanguage, resources, type SupportedLanguage } from "./resources";

export const LANGUAGE_STORAGE_KEY = "openagentpack.workbench.language";

function detectedLanguage(): SupportedLanguage {
	if (typeof window === "undefined") return "en-US";
	return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? window.navigator.language);
}

void i18n.use(initReactI18next).init({
	resources,
	lng: detectedLanguage(),
	fallbackLng: "en-US",
	supportedLngs: ["en-US", "zh-CN"],
	interpolation: { escapeValue: false },
	initImmediate: false,
});

function persistLanguage(language: string): void {
	if (typeof document !== "undefined") document.documentElement.lang = normalizeLanguage(language);
	if (typeof window !== "undefined") window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
}

persistLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", persistLanguage);

export type { SupportedLanguage } from "./resources";
export { i18n };

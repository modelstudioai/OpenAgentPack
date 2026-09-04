import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeLanguage, type SupportedLanguage } from "./resources";

export function LanguageSwitcher() {
	const { i18n, t } = useTranslation();
	const language = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
	return (
		<label className="language-switcher">
			<Languages />
			<span className="sr-only">{t("common.language")}</span>
			<select
				aria-label={t("common.language")}
				value={language}
				onChange={(event) => void i18n.changeLanguage(event.target.value as SupportedLanguage)}
			>
				<option value="en-US">{t("common.english")}</option>
				<option value="zh-CN">{t("common.chinese")}</option>
			</select>
		</label>
	);
}

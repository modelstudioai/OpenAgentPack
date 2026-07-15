import { Settings2 } from "lucide-react";

export default function SettingsConfigHint() {
	return (
		<div className="settings-config-hint" role="status" aria-live="polite">
			<span className="settings-config-hint-arrow" aria-hidden="true" />
			<div className="settings-config-hint-icon" aria-hidden="true">
				<Settings2 size={14} strokeWidth={2.25} />
			</div>
			<div className="settings-config-hint-copy">
				<p className="settings-config-hint-title">完成 Provider 配置</p>
				<p className="settings-config-hint-desc">填写 API 凭据后即可体验完整功能</p>
			</div>
		</div>
	);
}

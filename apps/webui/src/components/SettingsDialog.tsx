import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	AGENTS_CONFIG_PROVIDERS,
	type AgentsConfig,
	type AgentsConfigProvider,
	loadAgentsConfig,
	persistAgentsConfig,
	providerFields,
} from "@/lib/domain/config-api";
import { notifyProviderConfigChanged } from "@/lib/store/provider-config-store";
import { pushToast } from "@/lib/store/toast-store";
import ProviderSelect from "./ProviderSelect";

type SettingsDialogProps = {
	open: boolean;
	onClose: () => void;
};

const PROVIDER_LABELS: Record<AgentsConfigProvider, string> = {
	bailian: "Bailian（阿里云百炼）",
	qoder: "Qoder",
	ark: "Ark（火山方舟）",
	claude: "Claude（Anthropic）",
};

function isAgentsProvider(value: string | undefined): value is AgentsConfigProvider {
	return !!value && (AGENTS_CONFIG_PROVIDERS as readonly string[]).includes(value);
}

function emptyFields(provider: AgentsConfigProvider): Record<string, string> {
	return Object.fromEntries(providerFields(provider).map((field) => [field.key, ""]));
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [provider, setProvider] = useState<AgentsConfigProvider | "">("");
	const [fields, setFields] = useState<Record<string, string>>({});
	const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		void loadAgentsConfig().then((config) => {
			if (cancelled) return;
			const savedProvider = isAgentsProvider(config?.AGENTS_PROVIDER) ? config.AGENTS_PROVIDER : "";
			setProvider(savedProvider);
			if (savedProvider) {
				const nextFields = emptyFields(savedProvider);
				for (const field of providerFields(savedProvider)) {
					nextFields[field.key] = config?.[field.key] ?? "";
				}
				setFields(nextFields);
			} else {
				setFields({});
			}
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const handleProviderChange = useCallback((nextProvider: AgentsConfigProvider | "") => {
		setProvider(nextProvider);
		setFields(nextProvider ? emptyFields(nextProvider) : {});
		setVisibleSecrets({});
	}, []);

	const toggleSecretVisibility = useCallback((key: string) => {
		setVisibleSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
	}, []);

	const handleFieldChange = useCallback((key: string, value: string) => {
		setFields((prev) => ({ ...prev, [key]: value }));
	}, []);

	const activeProvider = isAgentsProvider(provider) ? provider : null;
	const canSubmit =
		activeProvider !== null && providerFields(activeProvider).every((field) => fields[field.key]?.trim());

	const handleSubmit = async () => {
		if (!activeProvider || !canSubmit || saving) return;
		setSaving(true);
		const payload: AgentsConfig = { AGENTS_PROVIDER: activeProvider };
		for (const field of providerFields(activeProvider)) {
			const value = fields[field.key]?.trim();
			if (!value) {
				setSaving(false);
				return;
			}
			payload[field.key] = value;
		}
		const result = await persistAgentsConfig(payload);
		setSaving(false);
		if (!result.ok) {
			pushToast({
				id: `settings-failed-${Date.now()}`,
				sessionId: "",
				variant: "failed",
				title: "配置保存失败",
				desc: result.message,
			});
			return;
		}
		pushToast({
			id: `settings-saved-${Date.now()}`,
			sessionId: "",
			variant: "done",
			title: "配置已保存",
			desc: "当前会话已生效，正在刷新页面数据",
		});
		notifyProviderConfigChanged();
		onClose();
	};

	useEffect(() => {
		const dialog = dialogRef.current;
		if (open && dialog && !dialog.open) dialog.showModal();
		return () => dialog?.close();
	}, [open]);

	if (!open) return null;

	return createPortal(
		<dialog
			ref={dialogRef}
			className="case-modal-overlay"
			aria-labelledby="settings-dialog-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<div className="provision-dialog settings-dialog">
				<div className="settings-dialog-body">
					<h3 id="settings-dialog-title" className="provision-dialog-title">
						设置
					</h3>
					<p className="provision-dialog-text">选择 Provider 并填写凭据</p>

					<label className="settings-field-label" htmlFor="settings-provider">
						Provider
					</label>
					<ProviderSelect
						id="settings-provider"
						value={provider}
						options={AGENTS_CONFIG_PROVIDERS}
						labels={PROVIDER_LABELS}
						disabled={loading || saving}
						onChange={handleProviderChange}
					/>

					{activeProvider
						? providerFields(activeProvider).map((field) => {
								const isSecret = field.secret;
								const isVisible = isSecret && visibleSecrets[field.key];
								return (
									<div key={field.key} className="settings-field">
										<label className="settings-field-label" htmlFor={`settings-${field.key}`}>
											{field.label}
										</label>
										<div className={isSecret ? "settings-secret-input" : undefined}>
											<input
												id={`settings-${field.key}`}
												className="provision-dialog-input"
												type={isSecret && !isVisible ? "password" : "text"}
												value={fields[field.key] ?? ""}
												disabled={loading || saving}
												autoComplete="off"
												onChange={(e) => handleFieldChange(field.key, e.target.value)}
											/>
											{isSecret ? (
												<button
													type="button"
													className="settings-secret-toggle"
													disabled={loading || saving}
													onClick={() => toggleSecretVisibility(field.key)}
													aria-label={isVisible ? "隐藏密码" : "显示密码"}
													title={isVisible ? "隐藏" : "显示"}
												>
													{isVisible ? (
														<svg
															width="18"
															height="18"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
														>
															<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
															<circle cx="12" cy="12" r="3" />
														</svg>
													) : (
														<svg
															width="18"
															height="18"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
														>
															<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
															<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
															<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
															<line x1="2" y1="2" x2="22" y2="22" />
														</svg>
													)}
												</button>
											) : null}
										</div>
									</div>
								);
							})
						: null}

					{loading ? <p className="settings-dialog-hint">正在加载配置…</p> : null}
				</div>

				<div className="settings-dialog-footer">
					<button type="button" className="pill-btn" disabled={saving} onClick={onClose}>
						取消
					</button>
					<button
						type="button"
						className="pill-btn primary"
						disabled={!canSubmit || loading || saving}
						onClick={() => void handleSubmit()}
					>
						确定
					</button>
				</div>
			</div>
		</dialog>,
		document.body,
	);
}

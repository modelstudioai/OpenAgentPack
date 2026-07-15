import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type PromptRequest, registerPromptDialog } from "@/lib/confirm-dialog";

// Sentinel option value: selecting it switches the dropdown to free-text entry.
const MANUAL_OPTION = "__manual__";

// Generic imperative single-line input dialog, sibling to ConfirmDialog. Mounted once;
// promptDialog(...) calls open it and await the entered value (null on cancel). Overlay
// uses `task-modal-overlay` so outside-click handlers elsewhere ignore it. When the request
// carries `options`, a dropdown is shown instead of a text field (with an optional "手动输入"
// escape hatch that reveals the text field).
export default function PromptDialog() {
	const [req, setReq] = useState<PromptRequest | null>(null);
	const [value, setValue] = useState("");
	const [selected, setSelected] = useState("");
	const resolverRef = useRef<((value: string | null) => void) | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const selectRef = useRef<HTMLSelectElement>(null);

	useEffect(() => {
		return registerPromptDialog(
			(next) =>
				new Promise<string | null>((resolve) => {
					resolverRef.current = resolve;
					setValue("");
					setSelected("");
					setReq(next);
				}),
		);
	}, []);

	const settle = useCallback((result: string | null) => {
		resolverRef.current?.(result);
		resolverRef.current = null;
		setReq(null);
		setValue("");
		setSelected("");
	}, []);

	const onEscape = useEffectEvent(() => {
		if (req && req.cancellable !== false) settle(null);
	});

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onEscape();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	// Focus the active field when the dialog opens (replaces autoFocus): the dropdown when options are
	// present, otherwise the text field — matching the prior autoFocus={!hasOptions} behavior.
	useEffect(() => {
		if (!req) return;
		if (req.options?.length) selectRef.current?.focus();
		else inputRef.current?.focus();
	}, [req]);

	if (!req) return null;

	const hasOptions = !!req.options?.length;
	const manualMode = !hasOptions || selected === MANUAL_OPTION;
	const trimmed = value.trim();
	// In dropdown mode the resolved value is the selected option; in (free-text or manual) mode it's
	// the typed value.
	const effective = manualMode ? trimmed : selected;
	const submit = () => {
		if (effective) settle(effective);
	};

	return createPortal(
		<div className="task-modal-overlay">
			<div className="provision-dialog-backdrop" />
			<div className="provision-dialog">
				<h3 className="provision-dialog-title">{req.title}</h3>
				{req.message && <p className="provision-dialog-text">{req.message}</p>}
				{hasOptions && (
					<select
						className="provision-dialog-input"
						ref={selectRef}
						value={selected}
						aria-label={req.title}
						onChange={(e) => setSelected(e.target.value)}
					>
						<option value="" disabled>
							请选择 API Key
						</option>
						{req.options?.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
						{req.allowManual && <option value={MANUAL_OPTION}>手动输入</option>}
					</select>
				)}
				{manualMode && (
					<input
						className="provision-dialog-input"
						ref={inputRef}
						type={req.secret ? "password" : "text"}
						value={value}
						placeholder={req.placeholder}
						aria-label={req.title}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
						}}
					/>
				)}
				<div className="provision-dialog-actions">
					{req.cancellable !== false && (
						<button type="button" className="provision-dialog-btn secondary" onClick={() => settle(null)}>
							{req.cancelText ?? "取消"}
						</button>
					)}
					<button type="button" className="provision-dialog-btn primary" disabled={!effective} onClick={submit}>
						{req.confirmText ?? "确定"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

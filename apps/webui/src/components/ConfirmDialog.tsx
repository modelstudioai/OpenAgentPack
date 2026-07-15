"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ConfirmRequest, registerConfirmDialog } from "@/lib/confirm-dialog";

// Generic imperative confirm dialog. Mounted once; confirmDialog(...) calls open it and
// await the user's choice. Overlay uses `task-modal-overlay` so outside-click handlers
// elsewhere ignore it.
export default function ConfirmDialog() {
	const [req, setReq] = useState<ConfirmRequest | null>(null);
	const resolverRef = useRef<((ok: boolean) => void) | null>(null);

	useEffect(() => {
		return registerConfirmDialog(
			(next) =>
				new Promise<boolean>((resolve) => {
					resolverRef.current = resolve;
					setReq(next);
				}),
		);
	}, []);

	const settle = useCallback((ok: boolean) => {
		resolverRef.current?.(ok);
		resolverRef.current = null;
		setReq(null);
	}, []);

	const onEscape = useEffectEvent(() => {
		if (req && req.cancellable !== false) settle(false);
	});

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onEscape();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	if (!req) return null;

	return createPortal(
		<div className="task-modal-overlay">
			<div className="provision-dialog-backdrop" />
			<div className="provision-dialog">
				<h3 className="provision-dialog-title">{req.title}</h3>
				{req.message && <p className="provision-dialog-text">{req.message}</p>}
				<div className="provision-dialog-actions">
					{req.cancellable !== false && (
						<button type="button" className="provision-dialog-btn secondary" onClick={() => settle(false)}>
							{req.cancelText ?? "取消"}
						</button>
					)}
					<button
						type="button"
						className={`provision-dialog-btn ${req.danger ? "danger" : "primary"}`}
						onClick={() => settle(true)}
					>
						{req.confirmText ?? "确定"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

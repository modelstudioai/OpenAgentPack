import { CheckCircle2, CircleAlert, Send, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { dismissToast, getToasts, subscribeToasts, type Toast } from "@/lib/store/toast-store";

interface ToastStackProps {
	onToastClick: (toast: Toast) => void;
}

export default function ToastStack({ onToastClick }: ToastStackProps) {
	const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

	return createPortal(
		<div className="toast-stack" aria-live="polite">
			{toasts.map((t) => (
				<div key={t.id} className={`toast toast-${t.variant}`}>
					<button type="button" className="toast-main" onClick={() => onToastClick(t)}>
						<span className="toast-icon">
							{t.variant === "done" ? (
								<CheckCircle2 size={18} />
							) : t.variant === "submitted" ? (
								<Send size={18} />
							) : (
								<CircleAlert size={18} />
							)}
						</span>
						<span className="toast-content">
							<span className="toast-title">
								{t.title}
								{t.sessionId && <span className="toast-cta"> · 点击查看</span>}
							</span>
							<span className="toast-desc">{t.desc}</span>
						</span>
					</button>
					<button
						className="toast-close"
						type="button"
						aria-label="关闭"
						onClick={(e) => {
							e.stopPropagation();
							dismissToast(t.id);
						}}
					>
						<X size={14} />
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
}

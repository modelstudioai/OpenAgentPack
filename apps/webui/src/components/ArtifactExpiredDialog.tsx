import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ArtifactExpiredDialogProps {
	fileName: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ArtifactExpiredDialog({ fileName, busy = false, onConfirm, onCancel }: ArtifactExpiredDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (dialog && !dialog.open) dialog.showModal();
		return () => dialog?.close();
	}, []);

	return createPortal(
		<dialog
			ref={dialogRef}
			className="case-modal-overlay artifact-expired-overlay"
			aria-labelledby="artifact-expired-title"
			onCancel={(event) => {
				event.preventDefault();
				onCancel();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onCancel();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				}
			}}
		>
			<div className="artifact-expired-dialog">
				<h3 id="artifact-expired-title" className="artifact-expired-title">
					链接已过期
				</h3>
				<p className="artifact-expired-body">是否重新生成下载链接？</p>
				<p className="artifact-expired-file" title={fileName}>
					文件：{fileName}
				</p>
				<div className="artifact-expired-actions">
					<button type="button" className="case-modal-btn" onClick={onCancel} disabled={busy}>
						取消
					</button>
					<button type="button" className="case-modal-btn primary" onClick={onConfirm} disabled={busy}>
						{busy ? (
							<>
								<Loader2 size={14} className="spin" />
								<span>发送中…</span>
							</>
						) : (
							"确认"
						)}
					</button>
				</div>
			</div>
		</dialog>,
		document.body,
	);
}

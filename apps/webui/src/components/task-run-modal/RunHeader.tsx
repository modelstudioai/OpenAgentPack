import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import type { RunPhase } from "@/lib/view/run-phase";
import type { Task } from "../TaskBox";

interface RunHeaderProps {
	task: Task;
	phase: RunPhase;
	statusLabel: string;
	isFull: boolean;
	onToggleFull: () => void;
	onMakeSame?: (input: { prompt: string; agentId?: string }) => void;
	onClose: () => void;
}

/** 运行弹窗头部：状态、标题、全屏与做同款 */
export function RunHeader({ task, phase, statusLabel, isFull, onToggleFull, onMakeSame, onClose }: RunHeaderProps) {
	return (
		<div className="case-modal-header">
			<div className="run-modal-title-wrap">
				<span className={`run-modal-status ${task.status}`}>
					{phase === "creating" || phase === "running" ? (
						<Loader2 size={14} className="spin" />
					) : phase === "failed" || phase === "canceled" ? (
						<span className="run-dot run-dot-failed" />
					) : (
						<span className="run-dot run-dot-done" />
					)}
					<span>{statusLabel}</span>
				</span>
				<h2 className="case-modal-title">{task.title}</h2>
			</div>
			<div className="case-modal-actions">
				<button
					className="run-modal-fullscreen"
					type="button"
					aria-label={isFull ? "退出全屏" : "全屏"}
					title={isFull ? "退出全屏" : "全屏"}
					onClick={onToggleFull}
				>
					{isFull ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
				</button>
				<button
					className="case-modal-btn primary"
					type="button"
					onClick={() => {
						const prompt = (task.prompt || task.title).trim();
						if (!prompt || !onMakeSame) return;
						onMakeSame({ prompt, agentId: task.agentId });
						onClose();
					}}
				>
					做同款
				</button>
			</div>
		</div>
	);
}

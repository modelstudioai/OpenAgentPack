import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import type { RunPhase } from "@/lib/view/run-phase";
import type { Task } from "../TaskBox";

interface RunHeaderProps {
	task: Task;
	phase: RunPhase;
	statusLabel: string;
	isFull: boolean;
	onToggleFull: () => void;
}

/** 运行弹窗头部：状态、标题、全屏 */
export function RunHeader({ task, phase, statusLabel, isFull, onToggleFull }: RunHeaderProps) {
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
				<h2 className="case-modal-title">{task.prompt || task.title}</h2>
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
			</div>
		</div>
	);
}

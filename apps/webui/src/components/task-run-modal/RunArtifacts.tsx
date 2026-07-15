import { Loader2 } from "lucide-react";
import type { extractArtifacts } from "@/lib/view/artifact";
import type { RunPhase } from "@/lib/view/run-phase";
import ArtifactView from "../ArtifactView";
import type { LucideIcon } from "./types";

interface RunArtifactsProps {
	Icon: LucideIcon;
	phase: RunPhase;
	creatingLabel: string;
	errorText: string;
	segments: ReturnType<typeof extractArtifacts>["segments"];
	resultText: string;
}

/** 运行弹窗左侧产物区 */
export function RunArtifacts({ Icon, phase, creatingLabel, errorText, segments, resultText }: RunArtifactsProps) {
	return (
		<div className="case-modal-result">
			<div className="case-result-main">
				{phase === "creating" ? (
					<div className="run-result-pending">
						<Loader2 size={28} className="spin" />
						<span>{creatingLabel}</span>
					</div>
				) : phase === "running" ? (
					<div className="run-result-pending">
						<Loader2 size={28} className="spin" />
						<span>Agent 正在生成产物...</span>
					</div>
				) : phase === "failed" || phase === "canceled" ? (
					<div className="run-result-text run-result-error">
						<Icon size={20} />
						<p>{errorText}</p>
					</div>
				) : (
					<ArtifactView segments={segments} fallbackMarkdown={resultText} />
				)}
			</div>
		</div>
	);
}

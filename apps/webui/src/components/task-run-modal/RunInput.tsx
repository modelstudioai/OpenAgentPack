import { ArrowUp, CircleAlert, Loader2 } from "lucide-react";

interface RunInputProps {
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	message: string;
	sendError: string | null;
	canSend: boolean;
	isSendBusy: boolean;
	disabled: boolean;
	onMessageChange: (value: string) => void;
	onSubmit: () => void;
}

/** 运行弹窗底部追问输入区 */
export function RunInput({
	inputRef,
	message,
	sendError,
	canSend,
	isSendBusy,
	disabled,
	onMessageChange,
	onSubmit,
}: RunInputProps) {
	return (
		<div className="run-followup">
			{sendError && (
				<div className="run-followup-error">
					<CircleAlert size={14} />
					<span>{sendError}</span>
				</div>
			)}
			<div className="run-followup-input-wrap">
				<textarea
					ref={inputRef}
					className="run-followup-input"
					rows={1}
					disabled={disabled}
					aria-label="继续输入指令"
					placeholder={disabled ? "任务创建中..." : "继续输入指令..."}
					value={message}
					onChange={(e) => onMessageChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							onSubmit();
						}
					}}
				/>
				<button
					className={`run-followup-send ${canSend ? "ready" : ""} ${isSendBusy ? "busy" : ""}`}
					type="button"
					aria-label={isSendBusy ? "Agent 正在回复" : "发送追问"}
					disabled={!canSend}
					onClick={onSubmit}
				>
					{isSendBusy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
				</button>
			</div>
		</div>
	);
}

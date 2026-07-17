import { X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArtifactAccessProvider } from "@/lib/artifact-access-context";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { deriveRunPhase, isRunLoadingDetails, runCreatingLabel, runStatusLabel } from "@/lib/view/run-phase";
import { buildRunTimeline } from "@/lib/view/run-timeline";
import { isTaskInProgress } from "@/lib/view/task-view";
import { typeIcons } from "./constants";
import { useRunFollowup } from "./hooks/useRunFollowup";
import { useRunTimelineScroll } from "./hooks/useRunTimelineScroll";
import { useTaskRunStream } from "./hooks/useTaskRunStream";
import { RunHeader } from "./RunHeader";
import { RunInput } from "./RunInput";
import { RunTimeline } from "./RunTimeline";
import type { TaskRunModalProps } from "./types";

export default function TaskRunModal({ open, task, onTaskUpdate, onClose }: TaskRunModalProps) {
	const [isFull, setIsFull] = useState(false);
	const submitInFlightRef = useRef(false);

	const taskRef = useRef(task);
	taskRef.current = task;
	const onTaskUpdateRef = useRef(onTaskUpdate);
	onTaskUpdateRef.current = onTaskUpdate;

	const eventsLength = task?.events.length ?? 0;
	const phase = task ? deriveRunPhase(task) : "done";
	const isCreating = phase === "creating";
	const isRunning = task ? isTaskInProgress(task) && !isCreating : false;

	const { messagesRef, contentRef, loadingOlderEvents, handleMessagesScroll } = useRunTimelineScroll({
		open,
		eventsLength,
		taskRef,
		onTaskUpdateRef,
	});

	const { message, send, inputRef, canSend, isSendBusy, regenerateDownloadLink, submitMessage, handleMessageChange } =
		useRunFollowup({
			open,
			isCreating,
			isRunning,
			taskRef,
			onTaskUpdateRef,
			onTaskUpdate,
			submitInFlightRef,
		});

	useTaskRunStream({
		open,
		task,
		sendSending: send.sending,
		taskRef,
		onTaskUpdateRef,
	});

	useBodyScrollLock(open);

	const onEscape = useEffectEvent(() => {
		if (isFull) {
			setIsFull(false);
			return true;
		}
		onClose();
		return false;
	});

	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (onEscape()) e.preventDefault();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open]);

	if (!open || !task) return null;

	const Icon = typeIcons[task.type];
	const isLoadingDetails = isRunLoadingDetails(task, phase);
	const timelineItems = buildRunTimeline(task.events, { isRunning });
	const creatingLabel = runCreatingLabel(task);
	const statusLabel = runStatusLabel(task, phase);

	return createPortal(
		<ArtifactAccessProvider onRegenerate={regenerateDownloadLink} regenerateBusy={send.sending}>
			<div className="case-modal-overlay">
				<div className={`case-modal task-run-modal ${isFull ? "full" : ""}`}>
					<button className="case-modal-close" onClick={onClose} type="button">
						<X size={20} />
					</button>

					<RunHeader
						task={task}
						phase={phase}
						statusLabel={statusLabel}
						isFull={isFull}
						onToggleFull={() => setIsFull((v) => !v)}
					/>

					<div className="case-modal-body">
						<div className="case-modal-chat">
							<RunTimeline
								task={task}
								Icon={Icon}
								phase={phase}
								isLoadingDetails={isLoadingDetails}
								creatingLabel={creatingLabel}
								timelineItems={timelineItems}
								messagesRef={messagesRef}
								contentRef={contentRef}
								loadingOlderEvents={loadingOlderEvents}
								hasOlderEvents={Boolean(task.eventsNextPageToken)}
								sendSending={send.sending}
								onMessagesScroll={handleMessagesScroll}
							/>
							<RunInput
								inputRef={inputRef}
								message={message}
								sendError={send.error}
								canSend={canSend}
								isSendBusy={isSendBusy}
								disabled={isCreating}
								onMessageChange={handleMessageChange}
								onSubmit={() => void submitMessage()}
							/>
						</div>
					</div>
				</div>
			</div>
		</ArtifactAccessProvider>,
		document.body,
	);
}

import { Loader2 } from "lucide-react";
import { formatTime } from "@/lib/view/run-event-display";
import type { RunPhase } from "@/lib/view/run-phase";
import { type RunTimelineItem, shouldShowAgentReplying } from "@/lib/view/run-timeline";
import { resolveTaskAttachedFiles } from "@/lib/view/user-message-files";
import type { Task } from "../TaskBox";
import UserMessageAttachments from "../UserMessageAttachments";
import UserMessageContent from "../UserMessageContent";
import { useNewAgentMessageKeys } from "./hooks/useNewAgentMessageKeys";
import { RunTimelineItemView } from "./RunTimelineItemView";
import type { LucideIcon } from "./types";

interface RunTimelineProps {
	task: Task;
	Icon: LucideIcon;
	phase: RunPhase;
	isLoadingDetails: boolean;
	creatingLabel: string;
	timelineItems: RunTimelineItem[];
	messagesRef: React.RefObject<HTMLDivElement | null>;
	contentRef: React.RefObject<HTMLDivElement | null>;
	loadingOlderEvents: boolean;
	hasOlderEvents: boolean;
	sendSending: boolean;
	onMessagesScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}

/** 运行弹窗右侧对话时间线 */
export function RunTimeline({
	task,
	Icon,
	phase,
	isLoadingDetails,
	creatingLabel,
	timelineItems,
	messagesRef,
	contentRef,
	loadingOlderEvents,
	hasOlderEvents,
	sendSending,
	onMessagesScroll,
}: RunTimelineProps) {
	const isCreating = phase === "creating";
	const isRunning = phase === "running";
	const displayTimeline = !isCreating && !isLoadingDetails;
	const showAgentReplying = shouldShowAgentReplying({
		isRunning,
		sendSending,
		isCreating,
		isLoadingDetails,
		timelineItems,
	});
	const revealKeys = useNewAgentMessageKeys({
		timelineItems,
		sessionId: task.id,
		open: true,
		displayTimeline,
	});

	return (
		<>
			<div className="case-chat-user">
				<div className="case-chat-avatar run-agent-avatar">
					<Icon size={16} />
				</div>
				<span className="case-chat-username">Agent · 运行轨迹</span>
				<span className="run-agent-time">{formatTime(task.createdAt)}</span>
			</div>

			<div className="case-chat-messages" ref={messagesRef} onScroll={onMessagesScroll}>
				<div ref={contentRef} className="case-chat-messages-inner">
					{(loadingOlderEvents || hasOlderEvents) && (
						<div className="run-events-load-older">
							{loadingOlderEvents ? (
								<>
									<Loader2 size={13} className="spin" />
									<span>正在加载更早记录...</span>
								</>
							) : (
								<span>向上滚动加载更早记录</span>
							)}
						</div>
					)}
					<div className="case-msg user">
						<div className="case-msg-bubble">
							<UserMessageAttachments files={resolveTaskAttachedFiles(task)} />
							<UserMessageContent text={task.prompt || task.title} className="case-msg-markdown" />
						</div>
					</div>

					{isCreating ? (
						<div className="case-msg agent">
							<div className="case-msg-bubble run-typing">
								<Loader2 size={13} className="spin" />
								<span>{creatingLabel}</span>
							</div>
						</div>
					) : isLoadingDetails ? (
						<div className="case-msg agent">
							<div className="case-msg-bubble run-typing">
								<Loader2 size={13} className="spin" />
								<span>正在加载 session events...</span>
							</div>
						</div>
					) : (
						timelineItems.map((item) => (
							<RunTimelineItemView key={item.key} item={item} revealContent={revealKeys.has(item.key)} />
						))
					)}

					{showAgentReplying && (
						<div className="case-msg agent">
							<div className="case-msg-bubble run-typing">
								<Loader2 size={13} className="spin" />
								<span>Agent 正在回复...</span>
							</div>
						</div>
					)}
				</div>
			</div>
		</>
	);
}

import type { SessionEvent } from "@openagentpack/sdk";
import { MarkdownRenderer } from "@/lib/markdown-renderer";
import { getEventContent } from "@/lib/view/run-event-display";
import { getMessageEventContent } from "../ToolChainPanel";
import UserMessageContent from "../UserMessageContent";
import { usePseudoStreamText } from "./hooks/usePseudoStreamText";

function EventSafetyNote({ event }: { event: SessionEvent }) {
	const redacted = event.metadata?.redacted === true;
	const truncated = event.metadata?.truncated === true;
	if (!redacted && !truncated) return null;
	const notes = [redacted ? "部分内容已脱敏" : null, truncated ? "内容已截断" : null].filter(Boolean);
	return <p className="run-event-meta">{notes.join(" · ")}</p>;
}

interface SessionEventItemProps {
	event: SessionEvent;
	messageKey: string;
	revealContent?: boolean;
}

/** 单条 message 类 event 的气泡渲染 */
export function SessionEventItem({ event, messageKey, revealContent = false }: SessionEventItemProps) {
	const role = event.role === "user" ? "user" : "agent";
	const content = getMessageEventContent(event) || getEventContent(event) || "";
	const shouldReveal = revealContent && role === "agent" && content.length > 0;
	const { displayedText, isRevealing } = usePseudoStreamText({
		text: content,
		enabled: shouldReveal,
		messageKey,
	});

	if (!content) return null;

	const MessageBody =
		role === "user" ? (
			<UserMessageContent text={displayedText} className="case-msg-markdown" />
		) : (
			<MarkdownRenderer text={displayedText} className="case-msg-markdown" />
		);

	return (
		<div className={`case-msg ${role}`}>
			<div className="case-msg-bubble">
				{MessageBody}
				{isRevealing ? <span className="run-stream-cursor" aria-hidden /> : null}
				{!isRevealing ? <EventSafetyNote event={event} /> : null}
			</div>
		</div>
	);
}

import { Fragment } from "react";
import { MarkdownRenderer } from "@/lib/markdown-renderer";
import {
	hasFileMentionSentinels,
	splitFileMentionSentinels,
	userMessageBodyForDisplay,
} from "@/lib/view/file-mention-render";

interface UserMessageContentProps {
	text: string;
	className?: string;
}

/** 用户消息正文：⟦file:mountPath⟧ 渲染为 mention tag，不修改原始字符串 */
export default function UserMessageContent({ text, className = "case-msg-markdown" }: UserMessageContentProps) {
	const displayText = userMessageBodyForDisplay(text).trim();
	if (!displayText) return null;

	if (!hasFileMentionSentinels(displayText)) {
		return <MarkdownRenderer text={displayText} className={className} />;
	}

	const segments = splitFileMentionSentinels(displayText);

	return (
		<div className={`${className} user-msg-with-mentions`} data-spm-protocol="i">
			{segments.map((segment) => {
				if (segment.kind === "mention") {
					return (
						<span key={`m-${segment.label}`} className="mention-tag" title={segment.path}>
							@{segment.label}
						</span>
					);
				}
				return <Fragment key={`t-${segment.value}`}>{segment.value}</Fragment>;
			})}
		</div>
	);
}

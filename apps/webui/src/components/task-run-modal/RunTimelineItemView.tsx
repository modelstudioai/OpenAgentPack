import type { RunTimelineItem } from "@/lib/view/run-timeline";
import ToolChainPanel from "../ToolChainPanel";
import { InlineArtifactCard } from "./InlineArtifactCard";
import { SessionEventItem } from "./SessionEventItem";

/** 时间线单项：message 气泡、工具链面板或内联产物卡片 */
export function RunTimelineItemView({ item }: { item: RunTimelineItem }) {
	if (item.kind === "tool_chain") {
		return <ToolChainPanel events={item.events} isActive={item.isActive} />;
	}
	if (item.kind === "artifact") {
		return <InlineArtifactCard segments={item.segments} />;
	}
	return <SessionEventItem event={item.event} messageKey={item.key} />;
}

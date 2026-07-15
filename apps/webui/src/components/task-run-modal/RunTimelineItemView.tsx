import type { RunTimelineItem } from "@/lib/view/run-timeline";
import ToolChainPanel from "../ToolChainPanel";
import { SessionEventItem } from "./SessionEventItem";

/** 时间线单项：message 气泡或工具链面板 */
export function RunTimelineItemView({
	item,
	revealContent = false,
}: {
	item: RunTimelineItem;
	revealContent?: boolean;
}) {
	if (item.kind === "tool_chain") {
		return <ToolChainPanel events={item.events} isActive={item.isActive} />;
	}
	return <SessionEventItem event={item.event} messageKey={item.key} revealContent={revealContent} />;
}

import { useEffect, useRef } from "react";
import type { RunTimelineItem } from "@/lib/view/run-timeline";

const EMPTY = new Set<string>();

function agentMessageKeys(items: RunTimelineItem[]): string[] {
	return items
		.filter(
			(item): item is Extract<RunTimelineItem, { kind: "message" }> =>
				item.kind === "message" && item.event.role !== "user",
		)
		.map((item) => item.key);
}

interface UseNewAgentMessageKeysOptions {
	timelineItems: RunTimelineItem[];
	sessionId: string | undefined;
	open: boolean;
	/** 时间线是否处于可展示状态（非创建中、非加载详情） */
	displayTimeline: boolean;
}

/**
 * 检测本次渲染中「新追加」的 Agent 消息 key。
 * 首次展示已有历史、向上加载更早记录时不触发伪流式。
 */
export function useNewAgentMessageKeys({
	timelineItems,
	sessionId,
	open,
	displayTimeline,
}: UseNewAgentMessageKeysOptions): ReadonlySet<string> {
	const seenKeysRef = useRef<Set<string>>(new Set());
	const seededRef = useRef(false);
	const sessionIdRef = useRef(sessionId);
	const revealKeysRef = useRef<Set<string>>(EMPTY);

	useEffect(() => {
		if (!open) {
			seenKeysRef.current = new Set();
			seededRef.current = false;
			revealKeysRef.current = EMPTY;
		}
	}, [open]);

	if (sessionIdRef.current !== sessionId) {
		sessionIdRef.current = sessionId;
		seenKeysRef.current = new Set();
		seededRef.current = false;
		revealKeysRef.current = EMPTY;
	}

	if (!open) {
		return EMPTY;
	}

	const keysInOrder = agentMessageKeys(timelineItems);

	if (!displayTimeline) {
		// 时间线尚未就绪时，持续预标记已有消息为历史，避免就绪后误判为新消息播放动画
		for (const key of keysInOrder) {
			seenKeysRef.current.add(key);
		}
		seededRef.current = true;
		return EMPTY;
	}

	if (!seededRef.current) {
		// 兜底：若未经历 !displayTimeline 阶段（如直接打开已完成会话），全量标记为历史
		seenKeysRef.current = new Set(keysInOrder);
		seededRef.current = true;
		revealKeysRef.current = EMPTY;
		return EMPTY;
	}

	const unseenKeys = keysInOrder.filter((key) => !seenKeysRef.current.has(key));
	if (unseenKeys.length === 0) {
		revealKeysRef.current = EMPTY;
		return EMPTY;
	}

	const seenInOrder = keysInOrder.filter((key) => seenKeysRef.current.has(key));
	const firstSeenIdx = seenInOrder.length === 0 ? Number.POSITIVE_INFINITY : keysInOrder.indexOf(seenInOrder[0]!);
	const firstUnseenIdx = keysInOrder.indexOf(unseenKeys[0]!);
	const isPrepend = firstUnseenIdx < firstSeenIdx;

	for (const key of unseenKeys) {
		seenKeysRef.current.add(key);
	}

	if (isPrepend) {
		revealKeysRef.current = EMPTY;
		return EMPTY;
	}

	const next = new Set(unseenKeys);
	revealKeysRef.current = next;
	return next;
}

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { fetchSessionEventsPage } from "@/lib/domain/session-api";
import type { Task } from "../../TaskBox";

interface UseRunTimelineScrollOptions {
	open: boolean;
	eventsLength: number;
	taskRef: React.MutableRefObject<Task | null>;
	onTaskUpdateRef: React.MutableRefObject<(task: Task) => void>;
}

const STICK_TO_BOTTOM_THRESHOLD_PX = 64;

/** 时间线滚动、加载更早 events 与 prepend 位置保持 */
export function useRunTimelineScroll({ open, eventsLength, taskRef, onTaskUpdateRef }: UseRunTimelineScrollOptions) {
	const messagesRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const loadingOlderRef = useRef(false);
	const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
	const scrollIntentRef = useRef<"bottom" | "preserve" | null>(null);
	const stickToBottomRef = useRef(true);
	const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);

	const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
		const el = messagesRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior });
	};

	const updateStickToBottom = (el: HTMLDivElement) => {
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
	};

	const loadOlderEvents = useEffectEvent(async () => {
		const current = taskRef.current;
		if (!current?.eventsNextPageToken || loadingOlderRef.current) return;
		loadingOlderRef.current = true;
		setLoadingOlderEvents(true);
		const el = messagesRef.current;
		if (el) prependScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
		scrollIntentRef.current = "preserve";
		stickToBottomRef.current = false;
		try {
			const page = await fetchSessionEventsPage(current.id, current.eventsNextPageToken, current.agentId);
			const latest = taskRef.current;
			if (!latest) return;
			const existingIds = new Set(
				latest.events.map((event) => event.event_id).filter((id): id is string => Boolean(id)),
			);
			const older = page.events.filter((event) => !event.event_id || !existingIds.has(event.event_id));
			onTaskUpdateRef.current({
				...latest,
				events: [...older, ...latest.events],
				eventsNextPageToken: page.events_next_page_token ?? undefined,
			});
		} catch (error) {
			scrollIntentRef.current = null;
			prependScrollRef.current = null;
			console.warn("Failed to load older session events", error);
		} finally {
			loadingOlderRef.current = false;
			setLoadingOlderEvents(false);
		}
	});

	const handleMessagesScroll = (e: React.UIEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		updateStickToBottom(el);
		if (el.scrollTop < STICK_TO_BOTTOM_THRESHOLD_PX) void loadOlderEvents();
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollToBottom / updateStickToBottom 仅读 ref，引用每轮都会变；加入 deps 会导致 effect 反复执行
	useLayoutEffect(() => {
		if (!open) return;
		const el = messagesRef.current;
		if (!el) return;
		if (scrollIntentRef.current === "preserve" && prependScrollRef.current) {
			const { height, top } = prependScrollRef.current;
			prependScrollRef.current = null;
			scrollIntentRef.current = null;
			el.scrollTop = el.scrollHeight - height + top;
			updateStickToBottom(el);
			return;
		}
		stickToBottomRef.current = true;
		scrollToBottom(eventsLength > 0 ? "smooth" : "auto");
	}, [open, eventsLength]);

	// 图片、Markdown 等异步撑高内容时，若用户仍在底部则补滚
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollToBottom 仅读 ref，引用每轮都会变；加入 deps 会导致 ResizeObserver 反复重建
	useEffect(() => {
		if (!open) return;
		const content = contentRef.current;
		if (!content) return;

		const observer = new ResizeObserver(() => {
			if (scrollIntentRef.current === "preserve") return;
			if (!stickToBottomRef.current) return;
			scrollToBottom("auto");
		});

		observer.observe(content);
		return () => observer.disconnect();
	}, [open]);

	return { messagesRef, contentRef, loadingOlderEvents, loadOlderEvents, handleMessagesScroll };
}

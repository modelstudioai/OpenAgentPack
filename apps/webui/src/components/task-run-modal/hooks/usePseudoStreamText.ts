import { useEffect, useRef, useState } from "react";

/** 本会话内已完成伪流式揭示的消息 key，避免重开弹窗重复播放 */
const revealedMessageKeys = new Set<string>();

interface UsePseudoStreamTextOptions {
	text: string;
	/** 是否启用逐字揭示 */
	enabled: boolean;
	/** 消息唯一 key，用于去重 */
	messageKey: string;
}

interface UsePseudoStreamTextResult {
	displayedText: string;
	isRevealing: boolean;
}

const MS_PER_CHAR = 35;
const MAX_REVEAL_MS = 45_000;
const MIN_CHARS_PER_TICK = 1;

function resolveRevealStep(textLength: number): { intervalMs: number; charsPerTick: number } {
	if (textLength <= 0) {
		return { intervalMs: MS_PER_CHAR, charsPerTick: MIN_CHARS_PER_TICK };
	}

	const idealDurationMs = textLength * MS_PER_CHAR;
	if (idealDurationMs <= MAX_REVEAL_MS) {
		return { intervalMs: MS_PER_CHAR, charsPerTick: MIN_CHARS_PER_TICK };
	}

	const totalTicks = Math.ceil(MAX_REVEAL_MS / MS_PER_CHAR);
	return {
		intervalMs: MS_PER_CHAR,
		charsPerTick: Math.max(MIN_CHARS_PER_TICK, Math.ceil(textLength / totalTicks)),
	};
}

/** 将完整文本以打字机节奏逐字揭示，模拟流式输出 */
export function usePseudoStreamText({
	text,
	enabled,
	messageKey,
}: UsePseudoStreamTextOptions): UsePseudoStreamTextResult {
	const latchRef = useRef<{ key: string; animate: boolean } | null>(null);
	// 记录动画是否已在当前挂载周期内启动，避免 text 变化时重置进行中的动画
	const animationStartedRef = useRef(false);

	if (!latchRef.current || latchRef.current.key !== messageKey) {
		const alreadyRevealed = revealedMessageKeys.has(messageKey);
		latchRef.current = {
			key: messageKey,
			animate: enabled && !alreadyRevealed && text.length > 0,
		};
		animationStartedRef.current = false;
	}

	const shouldAnimate = latchRef.current.animate;

	const [displayedLength, setDisplayedLength] = useState(() => (shouldAnimate ? 0 : text.length));

	useEffect(() => {
		if (!shouldAnimate) {
			setDisplayedLength(text.length);
			return;
		}

		// 动画已启动或已完成时（如 SSE 结束后 fetchSession 刷新 text），直接同步最新文本长度
		if (animationStartedRef.current || revealedMessageKeys.has(messageKey)) {
			setDisplayedLength(text.length);
			return;
		}

		animationStartedRef.current = true;
		setDisplayedLength(0);
		const snapshotLength = text.length;
		const { intervalMs, charsPerTick } = resolveRevealStep(snapshotLength);

		const timer = window.setInterval(() => {
			setDisplayedLength((prev) => {
				const next = Math.min(prev + charsPerTick, snapshotLength);
				if (next >= snapshotLength) {
					window.clearInterval(timer);
					revealedMessageKeys.add(messageKey);
				}
				return next;
			});
		}, intervalMs);

		return () => window.clearInterval(timer);
	}, [text, shouldAnimate, messageKey]);

	const displayedText = text.slice(0, displayedLength);
	const isRevealing = shouldAnimate && displayedLength < text.length;

	return { displayedText, isRevealing };
}

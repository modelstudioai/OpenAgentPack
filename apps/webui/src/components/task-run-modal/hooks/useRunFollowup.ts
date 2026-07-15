import { useEffect, useEffectEvent, useRef, useState } from "react";
import { buildRegenerateDownloadLinkMessage } from "@/lib/artifact-file-name";
import { sendSessionMessage } from "@/lib/domain/session-api";
import { isTaskInProgress, mapSessionDetail } from "@/lib/view/task-view";
import type { Task } from "../../TaskBox";
import type { SendState } from "../types";

interface UseRunFollowupOptions {
	open: boolean;
	isCreating: boolean;
	isRunning: boolean;
	taskRef: React.MutableRefObject<Task | null>;
	onTaskUpdateRef: React.MutableRefObject<(task: Task) => void>;
	onTaskUpdate: (task: Task) => void;
	submitInFlightRef: React.MutableRefObject<boolean>;
}

/** 追问输入、发送与产物链接重新生成 */
export function useRunFollowup({
	open,
	isCreating,
	isRunning,
	taskRef,
	onTaskUpdateRef,
	onTaskUpdate,
	submitInFlightRef,
}: UseRunFollowupOptions) {
	const [message, setMessage] = useState("");
	const [send, setSend] = useState<SendState>({ sending: false, error: null });
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const syncInputHeight = () => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 108)}px`;
	};

	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => inputRef.current?.focus(), 100);
		return () => clearTimeout(timer);
	}, [open]);

	const regenerateDownloadLink = useEffectEvent(async (fileName: string) => {
		const current = taskRef.current;
		if (!current || submitInFlightRef.current || current.status === "creating") return;

		submitInFlightRef.current = true;
		setSend({ sending: true, error: null });
		try {
			const text = buildRegenerateDownloadLinkMessage(fileName);
			const next = mapSessionDetail(await sendSessionMessage(current.id, text, current.agentId));
			taskRef.current = next;
			onTaskUpdateRef.current(next);
		} catch (error) {
			setSend((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
		} finally {
			submitInFlightRef.current = false;
			setSend((s) => ({ ...s, sending: false }));
		}
	});

	const submitMessage = async () => {
		if (submitInFlightRef.current) return;

		const current = taskRef.current;
		if (!current) return;

		const value = message.trim();
		if (!value || isTaskInProgress(current)) return;

		submitInFlightRef.current = true;
		setSend({ sending: true, error: null });
		try {
			const next = mapSessionDetail(await sendSessionMessage(current.id, value, current.agentId));
			taskRef.current = next;
			onTaskUpdate(next);
			setMessage("");
			requestAnimationFrame(syncInputHeight);
		} catch (error) {
			setSend((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
		} finally {
			submitInFlightRef.current = false;
			setSend((s) => ({ ...s, sending: false }));
		}
	};

	const handleMessageChange = (value: string) => {
		setMessage(value);
		if (send.error) setSend((s) => ({ ...s, error: null }));
		requestAnimationFrame(syncInputHeight);
	};

	const isSendBusy = send.sending || isRunning;
	const canSend = Boolean(message.trim()) && !isSendBusy && !isCreating;

	return {
		message,
		send,
		inputRef,
		canSend,
		isSendBusy,
		regenerateDownloadLink,
		submitMessage,
		handleMessageChange,
	};
}

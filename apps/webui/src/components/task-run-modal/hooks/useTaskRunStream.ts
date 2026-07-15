import { useEffect } from "react";
import { connectSessionStream } from "@/lib/api/stream";
import { fetchSession } from "@/lib/domain/session-api";
import { isTaskInProgress, mapSessionDetail } from "@/lib/view/task-view";
import type { Task } from "../../TaskBox";

interface UseTaskRunStreamOptions {
	open: boolean;
	task: Task | null;
	sendSending: boolean;
	taskRef: React.MutableRefObject<Task | null>;
	onTaskUpdateRef: React.MutableRefObject<(task: Task) => void>;
}

/** SSE 订阅与 session 详情拉取 */
export function useTaskRunStream({ open, task, sendSending, taskRef, onTaskUpdateRef }: UseTaskRunStreamOptions): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: task/onTaskUpdate are read via refs on purpose; depending on the task object or task.events.length would reset the stream subscription on every event and never stop
	useEffect(() => {
		if (!open || !task) return;
		if (task.status === "creating") return;

		let canceled = false;
		let cleanupStream: (() => void) | null = null;

		const isActive = isTaskInProgress(task) || sendSending;
		const sessionId = task.id;
		const agentId = task.agentId;

		if (isActive) {
			const afterIndex = (taskRef.current?.events.length ?? 0) - 1;
			cleanupStream = connectSessionStream(sessionId, afterIndex, {
				onEvent: (event) => {
					if (canceled) return;
					const current = taskRef.current;
					if (!current) return;
					onTaskUpdateRef.current({
						...current,
						events: [...current.events, event],
					});
				},
				onDone: (_error) => {
					if (canceled) return;
					void fetchSession(sessionId, agentId)
						.then((detail) => {
							if (canceled) return;
							onTaskUpdateRef.current(mapSessionDetail(detail));
						})
						.catch(() => {});
				},
				onConnectionError: () => {
					if (canceled) return;
					void fetchSession(sessionId, agentId)
						.then((detail) => {
							if (canceled) return;
							onTaskUpdateRef.current(mapSessionDetail(detail));
						})
						.catch(() => {});
				},
			});
		} else {
			void fetchSession(sessionId, agentId)
				.then((detail) => {
					if (canceled) return;
					onTaskUpdateRef.current(mapSessionDetail(detail));
				})
				.catch((error) => {
					console.warn("Failed to fetch OpenAgentPack task", error);
				});
		}

		return () => {
			canceled = true;
			if (cleanupStream) cleanupStream();
		};
		// oxlint-disable-next-line react-doctor/exhaustive-deps
	}, [open, task?.id, task?.agentId, task?.status, sendSending]);
}

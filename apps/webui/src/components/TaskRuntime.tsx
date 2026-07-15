import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getActiveTask, setActiveTask, subscribeActiveTask } from "@/lib/store/active-task-store";
import {
	type ClientTask,
	getTaskStoreSnapshot,
	subscribeTaskStore,
	updateTaskInStore,
} from "@/lib/store/task-client-store";
import { pushToast } from "@/lib/store/toast-store";
import { mergeClientTask } from "@/lib/view/task-view";
import type { Task } from "./TaskBox";
import TaskRunModal from "./task-run-modal";

// Single-mount owner of the global task surface: status-transition toasts, the toast stack, and the
// one run modal. Mounted exactly once (in Composer); the many TaskBox triggers only flip shared
// state. The submit flow drives the stores directly (see lib/store/task-submit-actions), so this
// owner just renders the modal off shared state and reacts to status changes.
export default function TaskRuntime({
	onMakeSame,
}: {
	onMakeSame?: (input: { prompt: string; agentId?: string }) => void;
}) {
	const taskSnapshot = useSyncExternalStore(subscribeTaskStore, getTaskStoreSnapshot, getTaskStoreSnapshot);
	const tasks = taskSnapshot.tasks;
	const selectedTask = useSyncExternalStore(subscribeActiveTask, getActiveTask, getActiveTask);

	// Keep the open task fresh as the store polls: derive the live view from the selection. A pending
	// placeholder (not yet in the store) falls through to its own object.
	const fromStore = selectedTask ? tasks.find((task) => task.id === selectedTask.id) : undefined;
	const activeTask = selectedTask ? (fromStore ? mergeClientTask(fromStore, selectedTask) : selectedTask) : null;

	const previousStatusesRef = useRef<Record<string, Task["status"]>>({});
	const initializedRef = useRef(false);

	// Surface status transitions (done / failed / canceled) as toasts. A task appearing for the first
	// time has no previous status, so its arrival never fires a transition toast (the submit flow
	// raises the "submitted" toast instead).
	useEffect(() => {
		const previous = previousStatusesRef.current;
		if (initializedRef.current) {
			for (const task of tasks) {
				const oldStatus = previous[task.id];
				if (!oldStatus || oldStatus === task.status) continue;
				if (task.status === "done") {
					pushToast({
						id: `done-${task.id}-${task.updatedAt}`,
						sessionId: task.id,
						variant: "done",
						title: "任务已完成",
						desc: task.title,
					});
				}
				if (task.status === "failed" || task.status === "canceled") {
					pushToast({
						id: `failed-${task.id}-${task.updatedAt}`,
						sessionId: task.id,
						variant: "failed",
						title: task.status === "canceled" ? "任务已取消" : "任务失败",
						desc: task.error || task.title,
					});
				}
			}
		}
		initializedRef.current = true;
		previousStatusesRef.current = Object.fromEntries(tasks.map((task) => [task.id, task.status]));
	}, [tasks]);

	const handleTaskUpdate = useCallback((task: ClientTask) => {
		const current = getActiveTask();
		const next =
			current?.modalKey && current.id === task.id && !task.modalKey ? { ...task, modalKey: current.modalKey } : task;
		setActiveTask(next);
		updateTaskInStore(next);
		previousStatusesRef.current[next.id] = next.status;
	}, []);

	return (
		<TaskRunModal
			key={activeTask?.modalKey ?? activeTask?.id}
			open={!!activeTask}
			task={activeTask}
			onTaskUpdate={handleTaskUpdate}
			onClose={() => setActiveTask(null)}
			onMakeSame={onMakeSame}
		/>
	);
}

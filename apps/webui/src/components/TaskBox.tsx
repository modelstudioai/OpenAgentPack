import { Inbox, Loader2 } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { confirmDialog } from "@/lib/confirm-dialog";
import { getActiveTask, setActiveTask } from "@/lib/store/active-task-store";
import {
	type ClientTask,
	getTaskStoreSnapshot,
	refreshTaskStore,
	removeTaskFromStore,
	subscribeTaskStore,
} from "@/lib/store/task-client-store";
import TaskListModal from "./TaskListModal";

export type Task = ClientTask;

export default function TaskBox() {
	const taskSnapshot = useSyncExternalStore(subscribeTaskStore, getTaskStoreSnapshot, getTaskStoreSnapshot);
	const tasks = taskSnapshot.tasks;

	const [modalOpen, setModalOpen] = useState(false);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const openTask = useCallback((task: Task) => {
		setActiveTask(task);
		setModalOpen(false);
	}, []);

	const handleDelete = useCallback(
		async (task: Task) => {
			if (deletingId) return;
			const ok = await confirmDialog({
				title: "删除任务",
				message: `确定删除「${task.title}」？删除后不可恢复。`,
				confirmText: "删除",
				cancelText: "取消",
				danger: true,
			});
			if (!ok) return;
			setDeletingId(task.id);
			if (getActiveTask()?.id === task.id) setActiveTask(null);
			try {
				await removeTaskFromStore(task.id);
			} catch {
				// removeTaskFromStore records the error on the store and re-syncs the list;
				// nothing more to do here beyond clearing the per-item spinner.
			} finally {
				setDeletingId(null);
			}
		},
		[deletingId],
	);

	const runningCount = tasks.filter((t) => t.status === "running").length;
	const totalCount = tasks.length;
	// Show the spinner during the initial load or while a task is running (background refresh).
	const showLoading = taskSnapshot.isLoading || runningCount > 0;

	return (
		<>
			<button
				className={`task-box-btn ${totalCount > 0 ? "has-tasks" : ""}`}
				type="button"
				onClick={() => setModalOpen(true)}
				title="任务列表"
			>
				<span className={`task-box-icon ${showLoading ? "running" : ""}`}>
					{showLoading ? <Loader2 size={18} strokeWidth={2} className="spin" /> : <Inbox size={18} strokeWidth={1.5} />}
				</span>
				{totalCount > 0 && <span className="task-box-badge">{totalCount}</span>}
			</button>

			{modalOpen && (
				<TaskListModal
					tasks={tasks}
					isLoading={taskSnapshot.isLoading}
					error={taskSnapshot.error}
					deletingId={deletingId}
					onSelect={openTask}
					onDelete={(task) => void handleDelete(task)}
					onClose={() => setModalOpen(false)}
					onReload={() => void refreshTaskStore({ force: true })}
				/>
			)}
		</>
	);
}

import type { ClientTask } from "../view/task-view";

// Which task's run modal is currently open. Shared so any TaskBox trigger and the global task-event
// handlers (in TaskRuntime) drive one single modal instead of a per-mount one.
let activeTask: ClientTask | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function subscribeActiveTask(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getActiveTask(): ClientTask | null {
	return activeTask;
}

export function setActiveTask(task: ClientTask | null): void {
	activeTask = task;
	emit();
}

export function updateActiveTask(updater: (current: ClientTask | null) => ClientTask | null): void {
	setActiveTask(updater(activeTask));
}

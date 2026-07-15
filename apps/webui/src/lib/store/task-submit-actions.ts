import type { SessionDetail } from "../domain/session-api";
import type { ClientTask } from "../view/task-view";
import { setActiveTask, updateActiveTask } from "./active-task-store";
import { addTaskToStore } from "./task-client-store";
import { pushToast } from "./toast-store";

// Task-creation orchestration shared by the submit flow (useSubmitTask) and the run-modal owner
// (TaskRuntime). Previously this crossed component boundaries as `task-pending`/`task-created`/
// `task-error` window CustomEvents; the stores are already global singletons, so the submit flow
// drives them directly instead of broadcasting through the DOM.

// Optimistic placeholder shown in the run modal while the session is created server-side.
// `provisioning` marks a first-use playbook whose agent (and custom skill) is being uploaded
// and scanned — a multi-minute wait — so the modal can set the right expectation.
function makePendingTask(
	id: string,
	prompt: string,
	agentId?: string,
	provisioning?: boolean,
	attachedFiles?: string[],
): ClientTask {
	const now = Date.now();
	const title = prompt.trim() || "新任务";
	return {
		id,
		modalKey: id,
		title,
		prompt,
		status: "creating",
		createdAt: now,
		updatedAt: now,
		type: "text",
		agentId,
		provisioning,
		attachedFiles,
		events: [],
	};
}

export interface BeginPendingTaskInput {
	id: string;
	prompt: string;
	agentId?: string;
	provisioning?: boolean;
	attachedFiles?: string[];
}

/** Open the run modal on an optimistic placeholder while the session is created. */
export function beginPendingTask(input: BeginPendingTaskInput): void {
	setActiveTask(makePendingTask(input.id, input.prompt, input.agentId, input.provisioning, input.attachedFiles));
}

/**
 * Adopt the created session: add it to the task list, surface a "submitted" toast, and hand the
 * open placeholder modal over to the real session id (preserving the stable modal key and any
 * optimistic prompt/attachments).
 */
export function commitCreatedTask(detail: SessionDetail, pendingId?: string): void {
	const task = addTaskToStore(detail);
	pushToast({
		id: `submitted-${task.id}`,
		sessionId: task.id,
		variant: "submitted",
		title: "任务已提交",
		desc: "完成后通知你",
	});
	updateActiveTask((current) =>
		current && pendingId && current.id === pendingId
			? {
					...task,
					modalKey: current.modalKey ?? pendingId,
					prompt: current.prompt || task.prompt,
					provisioning: current.provisioning,
					attachedFiles: current.attachedFiles?.length ? current.attachedFiles : task.attachedFiles,
				}
			: current,
	);
}

/**
 * Surface a submit failure. If the creating placeholder is still open, mark it failed inside its
 * modal rather than silently closing it, and always raise a failure toast.
 */
export function failPendingTask(message: string, pendingId?: string): void {
	const desc = message || "请稍后重试";
	if (pendingId) {
		updateActiveTask((current) =>
			current && current.id === pendingId && current.status === "creating"
				? { ...current, status: "failed", error: desc }
				: current,
		);
	}
	pushToast({
		id: `submit-failed-${Date.now()}`,
		sessionId: "",
		variant: "failed",
		title: "任务提交失败",
		desc,
	});
}

import { type ClientTask, isTaskInProgress } from "./task-view";

/** 运行弹窗生命周期阶段 */
export type RunPhase = "creating" | "running" | "failed" | "canceled" | "done";

/** 从 task 状态推导当前运行阶段 */
export function deriveRunPhase(task: ClientTask): RunPhase {
	const isCreating = task.status === "creating";
	const inProgress = isTaskInProgress(task);
	const isRunning = inProgress && !isCreating;
	if (isCreating) return "creating";
	if (isRunning) return "running";
	if (task.status === "failed") return "failed";
	if (task.status === "canceled") return "canceled";
	return "done";
}

/** 运行中且尚无 events 时为 true */
export function isRunLoadingDetails(task: ClientTask, phase: RunPhase): boolean {
	return phase === "running" && task.events.length === 0;
}

/** 创建阶段的提示文案 */
export function runCreatingLabel(task: ClientTask): string {
	return task.provisioning ? "正在准备场景环境，首次约需 3–5 分钟…" : "正在创建任务...";
}

/** 头部状态标签文案 */
export function runStatusLabel(task: ClientTask, phase: RunPhase): string {
	if (phase === "creating") return task.provisioning ? "准备中" : "创建中";
	if (phase === "running") return "运行中";
	if (phase === "failed") return "已失败";
	if (phase === "canceled") return "已取消";
	return "已完成";
}

import type { SessionEvent } from "@openagentpack/sdk";
import { parseFileMountHint } from "@/lib/file-mount-hint";
import { displayBucketOf, eventText } from "./session-event-display";
import type { ClientTask } from "./task-view";

/** 从 session events 的首条 user 消息中解析上传附件名 */
export function attachedFilesFromEvents(events: SessionEvent[]): string[] {
	for (const event of events) {
		if (displayBucketOf(event) !== "message" || event.role !== "user") continue;
		const parsed = parseFileMountHint(eventText(event));
		return parsed?.files ?? [];
	}
	return [];
}

/** 任务关联的上传附件：优先 task 字段，否则从 events 回退解析 */
export function resolveTaskAttachedFiles(task: ClientTask): string[] {
	if (task.attachedFiles && task.attachedFiles.length > 0) return task.attachedFiles;
	return attachedFilesFromEvents(task.events);
}

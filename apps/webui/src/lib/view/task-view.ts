import type { Session, SessionEvent } from "@openagentpack/sdk";
import { humanizeApiErrorMessage } from "../api/error-message";
import type { SessionDetail } from "../domain/session-api";
import { displayBucketOf, eventText } from "./session-event-display";
import { attachedFilesFromEvents } from "./user-message-files";

export interface ClientTask {
	id: string;
	title: string;
	prompt: string;
	status: "creating" | "running" | "done" | "failed" | "canceled";
	createdAt: number;
	updatedAt: number;
	type: "text" | "video" | "image" | "app";
	sessionId?: string;
	agentId?: string;
	events: SessionEvent[];
	error?: string;
	/** 更早一页 events 的分页游标（接口 nextPageToken / next_page） */
	eventsNextPageToken?: string;
	/** 任务创建时用户选中的附件（展示名，不含 Agents__ 前缀） */
	attachedFiles?: string[];
	/** Optimistic-only: this playbook needs first-use provisioning (slow skill upload+scan). */
	provisioning?: boolean;
	/** Stable React key for the run modal across pending → real session id handoff. */
	modalKey?: string;
}

export function mapSessionDetail(detail: SessionDetail): ClientTask {
	const task = normalizeTaskFromDetail(mapSession(detail.session, detail.events), detail.events);
	const attachedFiles = attachedFilesFromEvents(detail.events);
	const eventsNextPageToken = detail.events_next_page_token ?? undefined;
	const base = attachedFiles.length > 0 ? { ...task, attachedFiles } : task;
	return eventsNextPageToken ? { ...base, eventsNextPageToken } : base;
}

export function mapSession(session: Session, events: SessionEvent[] = []): ClientTask {
	const title = session.title?.trim() || session.session_id;
	const error = errorFromEvents(events);
	return {
		id: session.session_id,
		title,
		prompt: title,
		status: deriveDisplayStatus(session.status, Boolean(error)),
		createdAt: session.created_at ? Date.parse(session.created_at) : Date.now(),
		updatedAt: session.updated_at ? Date.parse(session.updated_at) : Date.now(),
		type: getSessionType(title),
		sessionId: session.session_id,
		agentId: session.agent?.agent_id,
		events,
		error,
	};
}

/** 任务是否仍在执行中（含 provider 误报 idle、尚无 agent 产出的阶段）。 */
export function isTaskInProgress(task: ClientTask): boolean {
	if (task.status === "creating" || task.status === "running") return true;
	if (task.status === "failed" || task.status === "canceled") return false;
	if (task.status === "done" && !hasAgentActivity(task.events) && !hasTerminalStatusEvent(task.events)) {
		return true;
	}
	return false;
}

/** 合并列表刷新与本地/stream 已知的 task，避免列表 summary 滞后导致状态回退。 */
export function mergeClientTask(incoming: ClientTask, current: ClientTask | undefined): ClientTask {
	if (!current) return incoming;
	const events = incoming.events.length > 0 ? incoming.events : current.events;
	let status = incoming.status;
	if (shouldPreserveActiveStatus(current, incoming) || shouldPreserveDoneStatus(current, incoming)) {
		status = current.status;
	}
	const attachedFiles =
		incoming.attachedFiles && incoming.attachedFiles.length > 0 ? incoming.attachedFiles : current.attachedFiles;
	const eventsNextPageToken = incoming.eventsNextPageToken ?? current.eventsNextPageToken;
	const merged = { ...incoming, events, status, attachedFiles, eventsNextPageToken };
	const modalKey = current?.modalKey ?? incoming.modalKey;
	const withModalKey = modalKey ? { ...merged, modalKey } : merged;
	// Only the detail path carries a complete event set, so empty events there means "no output yet"
	// → idle is a false report → running. In the list-merge path empty events just means the summary
	// never carries events; normalizing then would flip every finished idle session to running and
	// drive an endless refresh poll. So only normalize when we actually have events to judge by.
	return events.length > 0 ? normalizeTaskFromDetail(withModalKey, events) : withModalKey;
}

/** 创建/详情接口可能在首轮 output 前误报 idle，归一化为 running。 */
export function normalizeTaskFromDetail(task: ClientTask, events: SessionEvent[] = task.events): ClientTask {
	if (task.status !== "done") return task;
	if (hasAgentActivity(events) || hasTerminalStatusEvent(events)) return task;
	return { ...task, status: "running" };
}

export function hasAgentActivity(events: SessionEvent[]): boolean {
	return events.some((event) => {
		if (event.type === "tool_call" || event.type === "tool_call_output") return true;
		return displayBucketOf(event) === "message" && event.role !== "user";
	});
}

function hasTerminalStatusEvent(events: SessionEvent[]): boolean {
	return events.some((event) => {
		if (event.type !== "status") return false;
		const status = event.metadata?.status;
		return status === "idle" || status === "completed" || status === "failed";
	});
}

function shouldPreserveActiveStatus(current: ClientTask, incoming: ClientTask): boolean {
	// 列表接口只返回 session summary，不含 events；刚创建时可能短暂误报 idle/completed。
	if (incoming.events.length > 0) return false;
	if (current.status !== "creating" && current.status !== "running") return false;
	if (incoming.status !== "done") return false;
	return incoming.updatedAt <= current.updatedAt;
}

/** 详情已确认 done 且有 agent 产出时，列表 summary 的 running 不能覆盖，否则会反复重连 stream / fetchSession。 */
function shouldPreserveDoneStatus(current: ClientTask, incoming: ClientTask): boolean {
	if (incoming.events.length > 0) return false;
	if (current.status !== "done") return false;
	if (incoming.status !== "running" && incoming.status !== "creating") return false;
	return hasAgentActivity(current.events) || hasTerminalStatusEvent(current.events);
}

function deriveDisplayStatus(status: string | undefined, hasError: boolean): ClientTask["status"] {
	if (status === "failed") return "failed";
	if (status === "terminated" || status === "deleted") return "canceled";
	if (hasError) return "failed";
	if (status === "idle" || status === "completed") return "done";
	return "running";
}

function errorFromEvents(events: SessionEvent[]): string | undefined {
	const errorEvent = events.find((event) => event.is_error || event.type === "error");
	if (!errorEvent) return undefined;
	const raw = errorEvent.message || eventText(errorEvent) || errorEvent.code || undefined;
	return raw ? humanizeApiErrorMessage(raw) : undefined;
}

function getSessionType(title: string): ClientTask["type"] {
	if (/视频|动画/.test(title)) return "video";
	if (/图片|图|插画|海报/.test(title)) return "image";
	if (/游戏|网站|应用|页面/.test(title)) return "app";
	return "text";
}

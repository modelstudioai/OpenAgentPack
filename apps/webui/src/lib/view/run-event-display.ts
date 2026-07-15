import type { SessionEvent } from "@openagentpack/sdk";
import { eventData, eventText } from "./session-event-display";

function formatValue(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** 格式化时间戳为 HH:MM:SS */
export function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 从 event 提取可展示的文本内容 */
export function getEventContent(event: SessionEvent): string {
	const text = eventText(event);
	if (text) return text;
	const data = eventData(event);
	if (data !== undefined) return formatValue(data);
	return event.message ?? "";
}

/** 为 React key 生成稳定标识 */
export function eventKey(event: SessionEvent): string {
	if (event.event_id) return event.event_id;
	return `${event.type}|${event.created_at ?? ""}|${event.role ?? ""}|${getEventContent(event).slice(0, 32)}`;
}

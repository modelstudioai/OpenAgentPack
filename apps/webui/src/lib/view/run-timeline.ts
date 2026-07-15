import type { SessionEvent } from "@openagentpack/sdk";
import { type DisplayBucket, displayBucketOf, eventData, eventText } from "./session-event-display";

export type RunTimelineItem =
	| { kind: "message"; event: SessionEvent; key: string }
	| { kind: "tool_chain"; events: SessionEvent[]; key: string; isActive: boolean };

/** 工具名 → 统计摘要用的中文类别 */
const TOOL_SUMMARY_LABELS: Record<string, string> = {
	Read: "阅读",
	Grep: "检索",
	Glob: "文件搜索",
	Bash: "命令",
	Write: "写入",
	Edit: "编辑",
	WebSearch: "检索",
	WebFetch: "网页抓取",
	DeliverArtifacts: "交付",
	download_file: "下载",
};

/** 工具调用 → 单行动作文案前缀 */
const TOOL_ACTION_LABELS: Record<string, string> = {
	Read: "查看",
	Grep: "检索",
	Glob: "搜索",
	Bash: "执行",
	Write: "写入",
	Edit: "编辑",
	WebSearch: "搜索",
	WebFetch: "抓取",
	DeliverArtifacts: "交付",
	download_file: "下载",
};

export interface ToolSummaryStat {
	label: string;
	count: number;
}

export interface ToolChainRow {
	key: string;
	kind: "thinking" | "action";
	label: string;
	target?: string;
	output?: string;
	durationMs?: number;
	event: SessionEvent;
	resultEvent?: SessionEvent;
}

function toolNameOf(event: SessionEvent): string {
	const fromMeta = event.metadata?.tool_name;
	if (typeof fromMeta === "string" && fromMeta) return fromMeta;
	const data = eventData(event);
	if (data && typeof data === "object" && "name" in data && typeof data.name === "string") {
		return data.name;
	}
	return "";
}

function isToolChainBucket(bucket: DisplayBucket): boolean {
	return bucket === "thinking" || bucket === "tool_use" || bucket === "tool_result";
}

function timelineEventKey(event: SessionEvent, index: number): string {
	if (event.event_id) return event.event_id;
	return `${event.type}|${event.created_at ?? ""}|${index}`;
}

function parseToolInputText(text: string): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		return { raw: text };
	}
	return null;
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function targetFromInput(input: Record<string, unknown> | null): string | undefined {
	if (!input) return undefined;
	return pickString(
		input.path,
		input.file_path,
		input.file,
		input.pattern,
		input.query,
		input.command,
		input.url,
		input.raw,
	);
}

function toolInputText(event: SessionEvent): string | undefined {
	const fromMeta = event.metadata?.tool_input;
	if (typeof fromMeta === "string" && fromMeta) return fromMeta;
	if (displayBucketOf(event) === "tool_use") {
		const text = eventText(event);
		return text || undefined;
	}
	return undefined;
}

/** 从工具输入中提取可读的目标（文件路径、检索词等） */
export function extractToolTarget(event: SessionEvent): string | undefined {
	const fromInput = targetFromInput(parseToolInputText(toolInputText(event) ?? ""));
	if (fromInput) return fromInput;
	return targetFromInput(parseToolInputText(eventText(event)));
}

function toolActionLabel(name: string): string {
	return TOOL_ACTION_LABELS[name] ?? (name ? `调用 ${name}` : "已操作");
}

function actionFromEvent(event: SessionEvent): { label: string; target?: string } {
	const name = toolNameOf(event);
	return {
		label: toolActionLabel(name),
		target: extractToolTarget(event),
	};
}

export function summarizeToolUses(events: SessionEvent[]): ToolSummaryStat[] {
	const counts = new Map<string, number>();
	for (const row of buildToolChainRows(events)) {
		if (row.kind !== "action") continue;
		const name = toolNameOf(row.event);
		if (!name) continue;
		const label = TOOL_SUMMARY_LABELS[name] ?? name;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return Array.from(counts.entries()).map(([label, count]) => ({ label, count }));
}

export function formatToolSummary(stats: ToolSummaryStat[]): string {
	if (stats.length === 0) return "";
	return stats.map((item) => `${item.count}次${item.label}`).join("，");
}

function eventTimestamp(event: SessionEvent): number | undefined {
	if (!event.created_at) return undefined;
	const ts = Date.parse(event.created_at);
	return Number.isFinite(ts) ? ts : undefined;
}

function thinkingDurationMs(event: SessionEvent, next?: SessionEvent): number | undefined {
	const start = eventTimestamp(event);
	const end = next ? eventTimestamp(next) : undefined;
	if (start === undefined || end === undefined || end <= start) return undefined;
	return end - start;
}

function formatToolOutput(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toolResultOutput(event: SessionEvent): string {
	return eventText(event) || formatToolOutput(eventData(event));
}

/**
 * 将工具调用与输出合并为单行操作项。
 * 运行中可能只有 tool_result（输出先到），需从 metadata 还原工具名与目标。
 */
export function buildToolChainRows(events: SessionEvent[]): ToolChainRow[] {
	const rows: ToolChainRow[] = [];
	let pendingActionIndex: number | null = null;

	for (let i = 0; i < events.length; i += 1) {
		const event = events[i]!;
		const bucket = displayBucketOf(event);
		const key = timelineEventKey(event, i);

		if (bucket === "thinking") {
			const text = eventText(event);
			if (!text) continue;
			pendingActionIndex = null;
			rows.push({
				key,
				kind: "thinking",
				label: "深度思考",
				output: text,
				durationMs: thinkingDurationMs(event, events[i + 1]),
				event,
			});
			continue;
		}

		if (bucket === "tool_use") {
			const { label, target } = actionFromEvent(event);
			rows.push({
				key,
				kind: "action",
				label,
				target,
				event,
			});
			pendingActionIndex = rows.length - 1;
			continue;
		}

		if (bucket === "tool_result") {
			const output = toolResultOutput(event);
			const { label, target } = actionFromEvent(event);
			const pending = pendingActionIndex !== null ? rows[pendingActionIndex] : undefined;

			if (pending?.kind === "action" && !pending.output) {
				rows[pendingActionIndex!] = {
					...pending,
					label: pending.label !== "已操作" ? pending.label : label,
					target: pending.target ?? target,
					output: output || undefined,
					resultEvent: event,
					key: `${pending.key}|${key}`,
				};
			} else if (label !== "已操作" || target || output) {
				rows.push({
					key,
					kind: "action",
					label,
					target,
					output: output || undefined,
					event,
					resultEvent: event,
				});
			}
			pendingActionIndex = null;
		}
	}

	return rows;
}

/** 将 session events 拆成消息块与工具链块，供运行轨迹面板渲染。 */
export function buildRunTimeline(events: SessionEvent[], options: { isRunning?: boolean } = {}): RunTimelineItem[] {
	const items: RunTimelineItem[] = [];
	let chainBuffer: SessionEvent[] = [];
	let chainStartIndex = 0;
	let sawMessage = false;

	const flushChain = (cursor: number) => {
		if (chainBuffer.length === 0) return;
		// 仅有空 thinking 标记、无可展示行时不生成操作区块（避免「暂无工具操作记录」）
		if (buildToolChainRows(chainBuffer).length === 0) {
			chainBuffer = [];
			return;
		}
		const isLastSegment = cursor >= events.length;
		items.push({
			kind: "tool_chain",
			events: chainBuffer,
			key: chainBuffer.map((event, index) => timelineEventKey(event, chainStartIndex + index)).join("|"),
			isActive: Boolean(options.isRunning) && isLastSegment,
		});
		chainBuffer = [];
	};

	for (let i = 0; i < events.length; i += 1) {
		const event = events[i]!;
		const bucket = displayBucketOf(event);

		if (bucket === "message") {
			const isLeading = !sawMessage;
			sawMessage = true;
			if (isLeading && event.role === "user") continue;

			flushChain(i);
			items.push({
				kind: "message",
				event,
				key: timelineEventKey(event, i),
			});
			continue;
		}

		if (bucket === "error") {
			flushChain(i);
			items.push({
				kind: "message",
				event,
				key: timelineEventKey(event, i),
			});
			continue;
		}

		if (isToolChainBucket(bucket)) {
			if (chainBuffer.length === 0) chainStartIndex = i;
			chainBuffer.push(event);
		}
	}

	flushChain(events.length);
	return items;
}

interface ShouldShowAgentReplyingOptions {
	isRunning: boolean;
	sendSending: boolean;
	isCreating: boolean;
	isLoadingDetails: boolean;
	timelineItems: RunTimelineItem[];
}

/** 右侧时间线是否展示「Agent 正在回复」等待态 */
export function shouldShowAgentReplying({
	isRunning,
	sendSending,
	isCreating,
	isLoadingDetails,
	timelineItems,
}: ShouldShowAgentReplyingOptions): boolean {
	if (isCreating || isLoadingDetails) return false;
	if (!isRunning && !sendSending) return false;

	// 任务仍在运行时始终提示「Agent 正在回复」，避免 assistant 已输出一段文本后
	// 进入思考/工具准备的空档期看起来像卡住。
	if (isRunning) return true;

	// 追问已提交但尚未进入运行态：仅在最后一条是用户消息时提示。
	const last = timelineItems[timelineItems.length - 1];
	return last?.kind === "message" && last.event.role === "user";
}

/** 从 timeline 中提取纯 message 类 events（供去重测试与展示过滤） */
export function getDisplayEvents(task: { events: SessionEvent[] }): SessionEvent[] {
	return buildRunTimeline(task.events)
		.filter((item): item is Extract<RunTimelineItem, { kind: "message" }> => item.kind === "message")
		.map((item) => item.event);
}

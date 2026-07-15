import type { SessionEvent } from "@openagentpack/sdk";
import { Brain, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "@/lib/markdown-renderer";
import { buildToolChainRows, formatToolSummary, summarizeToolUses, type ToolChainRow } from "@/lib/view/run-timeline";
import { eventText } from "@/lib/view/session-event-display";

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
	return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function EventSafetyNote({ event }: { event: SessionEvent }) {
	const redacted = event.metadata?.redacted === true;
	const truncated = event.metadata?.truncated === true;
	if (!redacted && !truncated) return null;
	const notes = [redacted ? "部分内容已脱敏" : null, truncated ? "内容已截断" : null].filter(Boolean);
	return <p className="run-tool-meta">{notes.join(" · ")}</p>;
}

function ThinkingRow({ row }: { row: ToolChainRow }) {
	const [open, setOpen] = useState(true);
	const duration = row.durationMs ? formatDuration(row.durationMs) : undefined;

	return (
		<div className="run-tool-thinking">
			<button type="button" className="run-tool-thinking-head" onClick={() => setOpen((v) => !v)}>
				<span>
					{row.label}
					{duration ? ` · ${duration}` : ""}
				</span>
				<ChevronDown size={14} className={`run-tool-chevron ${open ? "open" : ""}`} aria-hidden />
			</button>
			{open && row.output && (
				<div className="run-tool-thinking-body">
					<MarkdownRenderer text={row.output} className="run-tool-markdown" />
					<EventSafetyNote event={row.event} />
				</div>
			)}
		</div>
	);
}

function ActionRow({ row }: { row: ToolChainRow }) {
	const [open, setOpen] = useState(false);
	const text = row.target ? `${row.label} ${row.target}` : row.label;
	const noteEvent = row.resultEvent ?? row.event;

	if (!row.output) {
		return <div className="run-tool-action">{text}</div>;
	}

	return (
		<div className="run-tool-action-block">
			<div className="run-tool-action">{text}</div>
			<button type="button" className="run-tool-output-toggle" onClick={() => setOpen((v) => !v)}>
				<span>查看输出</span>
				<ChevronDown size={14} className={`run-tool-chevron ${open ? "open" : ""}`} aria-hidden />
			</button>
			{open && (
				<div className="run-tool-output-wrap">
					<pre className="run-tool-output-body">{row.output}</pre>
					<EventSafetyNote event={noteEvent} />
				</div>
			)}
		</div>
	);
}

function ToolChainRowItem({ row }: { row: ToolChainRow }) {
	switch (row.kind) {
		case "thinking":
			return <ThinkingRow row={row} />;
		case "action":
			return <ActionRow row={row} />;
	}
}

interface ToolChainPanelProps {
	events: SessionEvent[];
	isActive: boolean;
}

export default function ToolChainPanel({ events, isActive }: ToolChainPanelProps) {
	const stats = summarizeToolUses(events);
	const summary = formatToolSummary(stats);
	const rows = buildToolChainRows(events);
	const [expanded, setExpanded] = useState(isActive);

	useEffect(() => {
		if (isActive) setExpanded(true);
	}, [isActive]);

	// 无可展示的思考/工具行时不渲染操作区块
	if (rows.length === 0) return null;

	const headerText = isActive
		? summary
			? `正在操作 ${summary}`
			: "正在执行工具操作…"
		: summary
			? `操作 ${summary}`
			: "操作";

	return (
		<div className={`run-tool-chain ${isActive ? "active" : ""} ${expanded ? "expanded" : ""}`}>
			<button type="button" className="run-tool-chain-head" onClick={() => setExpanded((v) => !v)}>
				<span className="run-tool-chain-icon" aria-hidden>
					{isActive ? <Loader2 size={16} className="spin" /> : <Brain size={16} />}
				</span>
				<span className="run-tool-chain-title">{headerText}</span>
				<ChevronDown size={16} className={`run-tool-chevron ${expanded ? "open" : ""}`} aria-hidden />
			</button>

			{expanded && (
				<div className="run-tool-chain-body">
					{rows.map((row) => (
						<ToolChainRowItem key={row.key} row={row} />
					))}
				</div>
			)}
		</div>
	);
}

/** 消息类 event 的内容提取（与 TaskRunModal 共用） */
export function getMessageEventContent(event: SessionEvent): string {
	const text = eventText(event);
	if (text) return text;
	if (event.message) return event.message;
	if (event.code) return event.code;
	return "";
}

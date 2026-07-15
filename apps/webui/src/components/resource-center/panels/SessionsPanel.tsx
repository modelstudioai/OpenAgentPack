import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { deleteApiSession } from "@/lib/api/client";
import { formatApiErrorMessage } from "@/lib/api/error-message";
import { confirmDialog } from "@/lib/confirm-dialog";
import type { ResourceCenterView } from "@/lib/domain/resource-center";
import { useRc } from "../context";
import { useSelectionSet } from "../hooks/useSelectionSet";
import { statusBadge } from "../shared/badges";
import { fmtTime, shortId } from "../shared/formatters";
import { LoadingRows } from "../shared/LoadingRows";

export function SessionsPanel() {
	const { view, loading, setError, updateView, refresh, refreshingSessions, refreshSessions } = useRc();
	const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
	const [bulkDeleting, setBulkDeleting] = useState(false);
	const { selected: selectedSessionIds, toggle, toggleAll, clear, removeMany } = useSelectionSet();

	const sessions = view?.sessions ?? [];

	// agent_id → display name for annotating each session.
	const agentNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const a of view?.agents ?? []) map.set(a.id, a.playbookName ?? a.name);
		return map;
	}, [view]);

	const sessionIds = sessions.map((s) => s.session_id);
	const selectedSessions = sessions.filter((s) => selectedSessionIds.has(s.session_id));
	const allSessionsSelected = sessions.length > 0 && selectedSessions.length === sessions.length;
	const someSessionsSelected = selectedSessions.length > 0;

	const handleDeleteSession = useCallback(
		async (session: ResourceCenterView["sessions"][number]) => {
			const label = session.title?.trim() || session.session_id;
			const ok = await confirmDialog({
				title: `删除会话「${label}」？`,
				message: `线上 ID ${session.session_id}。删除后该 Session 及其历史不可恢复。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingSessionId(session.session_id);
			setError(null);
			const res = await deleteApiSession({
				path: { sessionId: session.session_id },
				query: { agentId: session.agent?.agent_id },
			});
			setDeletingSessionId(null);
			if (res.error) {
				setError(formatApiErrorMessage(res.error, "删除会话失败"));
				return;
			}
			updateView((prev) => ({
				...prev,
				sessions: prev.sessions.filter((s) => s.session_id !== session.session_id),
			}));
			refresh();
		},
		[setError, updateView, refresh],
	);

	const handleBulkDeleteSessions = useCallback(
		async (targets: ResourceCenterView["sessions"]) => {
			if (targets.length === 0) return;
			const ok = await confirmDialog({
				title: `删除选中的 ${targets.length} 个会话？`,
				message: "这些 Session 及其历史将不可恢复。",
				confirmText: `删除 ${targets.length} 个`,
				danger: true,
			});
			if (!ok) return;
			setBulkDeleting(true);
			setError(null);
			const results = await Promise.allSettled(
				targets.map((s) =>
					deleteApiSession({ path: { sessionId: s.session_id }, query: { agentId: s.agent?.agent_id } }).then((res) => {
						if (res.error) throw new Error(formatApiErrorMessage(res.error, "删除会话失败"));
						return s.session_id;
					}),
				),
			);
			const deleted = new Set(
				results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value),
			);
			const failed = results.length - deleted.size;
			setBulkDeleting(false);
			updateView((prev) => ({
				...prev,
				sessions: prev.sessions.filter((s) => !deleted.has(s.session_id)),
			}));
			removeMany(deleted);
			if (failed > 0) setError(`${failed} 个会话删除失败，请重试。`);
			refresh();
		},
		[setError, updateView, refresh, removeMany],
	);

	return (
		<section className="rc-panel" aria-label="会话">
			<div className="rc-panel-head">
				<div>
					<div className="rc-panel-title">Session（当前 WebUI 创建）</div>
					<div className="rc-panel-sub">按当前应用 Agent 收口的会话 · 最新在前</div>
				</div>
				<div className="rc-bulk-bar">
					{someSessionsSelected ? (
						<>
							<span className="rc-dim">已选 {selectedSessions.length} 项</span>
							<button className="pill-btn" type="button" onClick={clear} disabled={bulkDeleting}>
								取消选择
							</button>
							<button
								className="pill-btn danger"
								type="button"
								onClick={() => void handleBulkDeleteSessions(selectedSessions)}
								disabled={bulkDeleting}
							>
								<Trash2 size={14} aria-hidden="true" />
								{bulkDeleting ? "删除中…" : `批量删除 ${selectedSessions.length}`}
							</button>
						</>
					) : null}
					<button
						className="icon-btn"
						type="button"
						aria-label="刷新会话"
						title="刷新会话"
						onClick={() => void refreshSessions()}
						disabled={loading || refreshingSessions}
					>
						<RefreshCw size={14} aria-hidden="true" className={loading || refreshingSessions ? "rc-spin" : undefined} />
					</button>
				</div>
			</div>
			<div className="rc-table-wrap">
				<table>
					<thead>
						<tr>
							<th className="rc-check-col">
								<input
									type="checkbox"
									aria-label="全选会话"
									checked={allSessionsSelected}
									ref={(el) => {
										if (el) el.indeterminate = someSessionsSelected && !allSessionsSelected;
									}}
									onChange={(e) => toggleAll(sessionIds, e.target.checked)}
									disabled={sessions.length === 0}
								/>
							</th>
							<th>标题</th>
							<th>状态</th>
							<th>Agent</th>
							<th>创建时间</th>
							<th>更新时间</th>
							<th>线上 ID</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{sessions.map((session) => {
							const badge = statusBadge(session.status);
							const agentId = session.agent?.agent_id;
							const agentName =
								session.agent?.name ?? (agentId ? (agentNameById.get(agentId) ?? shortId(agentId)) : "—");
							const checked = selectedSessionIds.has(session.session_id);
							return (
								<tr key={session.session_id} className={checked ? "selected" : ""}>
									<td className="rc-check-col">
										<input
											type="checkbox"
											aria-label={`选择会话 ${session.title?.trim() || session.session_id}`}
											checked={checked}
											onChange={() => toggle(session.session_id)}
										/>
									</td>
									<td className="rc-agent-name" title={session.title?.trim() || session.session_id}>
										{session.title?.trim() || session.session_id}
									</td>
									<td>
										<span className={`rc-badge ${badge.cls}`}>{badge.text}</span>
									</td>
									<td>{agentName}</td>
									<td className="rc-dim">{fmtTime(session.created_at)}</td>
									<td className="rc-dim">{fmtTime(session.updated_at)}</td>
									<td className="rc-mono">{shortId(session.session_id)}</td>
									<td className="rc-row-actions">
										<button
											className="icon-btn danger"
											type="button"
											aria-label={`删除会话 ${session.title?.trim() || session.session_id}`}
											title="删除此会话"
											disabled={deletingSessionId === session.session_id}
											onClick={() => void handleDeleteSession(session)}
										>
											<Trash2 size={13} aria-hidden="true" />
										</button>
									</td>
								</tr>
							);
						})}
						{!loading && view && view.sessions.length === 0 ? (
							<tr>
								<td colSpan={8} className="rc-empty">
									<div className="rc-empty-title">暂无会话</div>
									<div className="rc-empty-desc">当前应用 Agent 还没有创建任何 Session。</div>
								</td>
							</tr>
						) : null}
						{loading && !view ? <LoadingRows cols={8} /> : null}
					</tbody>
				</table>
			</div>
		</section>
	);
}

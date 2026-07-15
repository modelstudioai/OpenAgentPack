import { Archive } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { archiveApiCloudAgent } from "@/lib/api/client";
import { formatApiErrorMessage } from "@/lib/api/error-message";
import { confirmDialog } from "@/lib/confirm-dialog";
import type { PlaybookResourceRow, ResourceAgentRow } from "@/lib/domain/resource-center";
import { useRc } from "../context";
import { withReferencedResources } from "../hooks/useResourceCenter";
import { playbookStatusBadge, referencedSkillBadge, relationBadge, statusBadge } from "../shared/badges";
import { fmtTime, shortId } from "../shared/formatters";
import { IdentityBadge } from "../shared/IdentityBadge";
import { LoadingRows } from "../shared/LoadingRows";

export function TopologyPanel() {
	const { view, loading, topology, setError, updateView, refresh } = useRc();
	const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(
		() => topology?.playbooks[0]?.playbookId ?? null,
	);
	const [archivingId, setArchivingId] = useState<string | null>(null);

	const selectedPlaybook = useMemo(
		() => topology?.playbooks.find((pb) => pb.playbookId === selectedPlaybookId) ?? topology?.playbooks[0] ?? null,
		[topology, selectedPlaybookId],
	);

	const handleArchive = useCallback(
		async (row: ResourceAgentRow) => {
			const ok = await confirmDialog({
				title: `归档「${row.name}」？`,
				message: `线上 ID ${row.id}。归档后该 Agent 从清单移除（软删除），可在控制台恢复。`,
				confirmText: "归档",
				danger: true,
			});
			if (!ok) return;
			setArchivingId(row.id);
			setError(null);
			const res = await archiveApiCloudAgent({ path: { agentId: row.id } });
			setArchivingId(null);
			if (res.error) {
				setError(formatApiErrorMessage(res.error, "归档失败"));
				return;
			}
			updateView((prev) => withReferencedResources({ ...prev, agents: prev.agents.filter((a) => a.id !== row.id) }));
			refresh();
		},
		[setError, updateView, refresh],
	);

	return (
		<section className="rc-topology-layout">
			<section className="rc-panel">
				<div className="rc-panel-head">
					<div>
						<div className="rc-panel-title">场景资源矩阵</div>
						<div className="rc-panel-sub">每行 = 一个本地玩法；列展示它与云端资源的关系摘要</div>
					</div>
				</div>
				<div className="rc-table-wrap">
					<table className="rc-topology-table">
						<thead>
							<tr>
								<th>场景</th>
								<th>Agent</th>
								<th>Session</th>
								<th>Skill</th>
								<th>MCP</th>
								<th>状态</th>
							</tr>
						</thead>
						<tbody>
							{topology?.playbooks.map((row) => {
								const badge = playbookStatusBadge(row.status);
								return (
									<tr
										key={row.playbookId}
										className={`${row.playbookId === selectedPlaybook?.playbookId ? "selected " : ""}rc-clickable-row`}
										onClick={() => setSelectedPlaybookId(row.playbookId)}
									>
										<td className="rc-agent-name" title={row.playbookName}>
											{row.playbookName}
											<span className="rc-topology-sub">{row.playbookId}</span>
										</td>
										<td>
											<span className={`rc-badge ${relationBadge(row.agent.status)}`}>{row.agent.label}</span>
											{row.agent.primary ? (
												<span className="rc-topology-sub">{shortId(row.agent.primary.id)}</span>
											) : null}
										</td>
										<td className="num">{row.sessions.label}</td>
										<td>
											<span className={`rc-badge ${relationBadge(row.skills.status)}`}>{row.skills.label}</span>
										</td>
										<td>
											<span className={`rc-badge ${relationBadge(row.mcp.status)}`}>{row.mcp.label}</span>
										</td>
										<td>
											<span className={`rc-badge ${badge.cls}`}>{badge.text}</span>
											{row.issues.length ? <span className="rc-topology-sub">{row.issues.join("、")}</span> : null}
										</td>
									</tr>
								);
							})}
							{!loading && topology && topology.playbooks.length === 0 ? (
								<tr>
									<td colSpan={6} className="rc-empty">
										暂无本地玩法。
									</td>
								</tr>
							) : null}
							{loading && !view ? <LoadingRows cols={6} /> : null}
						</tbody>
					</table>
				</div>
			</section>

			<aside className="rc-panel rc-detail-panel">
				<div className="rc-panel-head">
					<div>
						<div className="rc-panel-title">场景详情</div>
						<div className="rc-panel-sub">当前选择 · 资源链路展开</div>
					</div>
				</div>
				<PlaybookDetail pb={selectedPlaybook} onArchive={(row) => void handleArchive(row)} archivingId={archivingId} />
			</aside>
		</section>
	);
}

// --- PlaybookDetail sub-component ---

function PlaybookDetail({
	pb,
	onArchive,
	archivingId,
}: {
	pb: PlaybookResourceRow | null;
	onArchive: (row: ResourceAgentRow) => void;
	archivingId: string | null;
}) {
	if (!pb) return <div className="rc-empty">选择左侧场景查看资源关系</div>;
	const latest = pb.sessions.latest;
	return (
		<div className="rc-detail-body rc-playbook-detail">
			<div>
				<h2 style={{ display: "flex", alignItems: "center", gap: 10 }}>
					{pb.playbookName}
					{pb.agent.primary ? (
						<button
							className="pill-btn danger"
							type="button"
							style={{ fontSize: 13, fontWeight: 500 }}
							disabled={archivingId === pb.agent.primary.id}
							onClick={() => onArchive(pb.agent.primary as ResourceAgentRow)}
						>
							<Archive size={14} aria-hidden="true" />
							{archivingId === pb.agent.primary.id ? "归档中…" : "归档"}
						</button>
					) : null}
				</h2>
				<p>
					<span className={`rc-badge ${playbookStatusBadge(pb.status).cls}`}>{pb.statusLabel}</span>
					<span className="rc-detail-inline">{pb.playbookId}</span>
				</p>
			</div>

			{pb.issues.length ? (
				<div className="rc-callout">
					<b>需要关注</b>：{pb.issues.join("、")}
				</div>
			) : null}

			<div className="rc-playbook-section">
				<div className="rc-reference-title">Agent</div>
				{pb.agent.primary ? (
					<div className="rc-info-grid">
						<div className="rc-info-key">名称</div>
						<div className="rc-info-value">{pb.agent.primary.name}</div>
						<div className="rc-info-key">状态</div>
						<div className="rc-info-value">
							<span className={`rc-badge ${relationBadge(pb.agent.status)}`}>{pb.agent.label}</span>
						</div>
						<div className="rc-info-key">身份戳</div>
						<div className="rc-info-value">
							<IdentityBadge identity={pb.agent.primary.identity} />
						</div>
						<div className="rc-info-key">线上 ID</div>
						<div className="rc-info-value rc-mono">{pb.agent.primary.id}</div>
					</div>
				) : (
					<div className="rc-empty compact">云端尚未创建对应 Agent。</div>
				)}
				{pb.agent.agents.length > 1 ? (
					<div className="rc-mini-list">
						{pb.agent.agents.map((agent) => (
							<span key={agent.id} className="rc-mini-item">
								{agent.name} <span className="rc-mono">{shortId(agent.id)}</span>
							</span>
						))}
					</div>
				) : null}
			</div>

			<div className="rc-playbook-section">
				<div className="rc-reference-title">Skill 依赖</div>
				{pb.skills.rows.length ? (
					<div className="rc-mini-list">
						{pb.skills.rows.map((skill) => (
							<span key={skill.key} className="rc-mini-item">
								{skill.name}
								<span className={`rc-badge ${referencedSkillBadge(skill.status).cls}`}>
									{referencedSkillBadge(skill.status).text}
								</span>
							</span>
						))}
					</div>
				) : (
					<div className="rc-empty compact">当前场景未声明 Skill。</div>
				)}
			</div>

			<div className="rc-playbook-section">
				<div className="rc-reference-title">MCP 依赖</div>
				{pb.mcp.rows.length ? (
					<div className="rc-mini-list">
						{pb.mcp.rows.map((server) => (
							<span key={server.key} className="rc-mini-item">
								{server.name}
								<span className={`rc-badge ${server.status === "attached" ? "playbook" : "agents"}`}>
									{server.status === "attached" ? "已挂载" : server.status === "pending" ? "待创建" : "缺失"}
								</span>
							</span>
						))}
					</div>
				) : (
					<div className="rc-empty compact">当前场景未声明 MCP。</div>
				)}
			</div>

			<div className="rc-playbook-section">
				<div className="rc-reference-title">最近 Session</div>
				{latest ? (
					<div className="rc-info-grid">
						<div className="rc-info-key">标题</div>
						<div className="rc-info-value">{latest.title?.trim() || latest.session_id}</div>
						<div className="rc-info-key">状态</div>
						<div className="rc-info-value">
							<span className={`rc-badge ${statusBadge(latest.status).cls}`}>{statusBadge(latest.status).text}</span>
						</div>
						<div className="rc-info-key">更新</div>
						<div className="rc-info-value">{fmtTime(latest.updated_at)}</div>
					</div>
				) : (
					<div className="rc-empty compact">暂无会话。</div>
				)}
			</div>
		</div>
	);
}

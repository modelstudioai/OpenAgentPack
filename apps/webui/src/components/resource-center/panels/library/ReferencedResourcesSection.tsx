import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { confirmDialog } from "@/lib/confirm-dialog";
import type { ReferencedSkillRow } from "@/lib/domain/resource-center";
import { deleteSkill } from "@/lib/domain/skill-api";
import { useRc } from "../../context";
import { withReferencedResources } from "../../hooks/useResourceCenter";
import { referencedMcpBadge, referencedSkillBadge } from "../../shared/badges";
import { compactList, shortId } from "../../shared/formatters";
import { LoadingRows } from "../../shared/LoadingRows";

export function ReferencedResourcesSection() {
	const { view, loading, setError, updateView, refresh } = useRc();
	const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);
	const referencedSkills = view?.referencedSkills ?? [];
	const referencedMcpServers = view?.referencedMcpServers ?? [];

	const handleDeleteReferencedSkill = useCallback(
		async (skill: ReferencedSkillRow) => {
			if (skill.type !== "custom" || !skill.providerCode) return;
			const ok = await confirmDialog({
				title: `删除 Skill「${skill.name}」？`,
				message: `线上 ID ${skill.providerCode}。删除后该 Skill 不可恢复；已引用它的历史会话不受影响。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingSkillId(skill.providerCode);
			setError(null);
			try {
				await deleteSkill(skill.providerCode);
			} catch (e) {
				setError(e instanceof Error ? e.message : "删除 Skill 失败");
				return;
			} finally {
				setDeletingSkillId(null);
			}
			updateView((prev) =>
				withReferencedResources({ ...prev, skills: prev.skills.filter((s) => s.id !== skill.providerCode) }),
			);
			refresh();
		},
		[setError, updateView, refresh],
	);

	return (
		<section className="rc-panel" aria-label="引用资源">
			<div className="rc-panel-head">
				<div>
					<div className="rc-panel-title">引用资源</div>
					<div className="rc-panel-sub">当前玩法声明的 Skill / MCP · 与工作空间和云端 Agent 配置核对</div>
				</div>
			</div>
			<div className="rc-reference-grid">
				<div className="rc-reference-block">
					<div className="rc-reference-title">Skill 引用</div>
					<div className="rc-table-wrap">
						<table>
							<thead>
								<tr>
									<th>名称</th>
									<th>类型</th>
									<th>状态</th>
									<th>声明玩法</th>
									<th>版本 / Code</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{referencedSkills.map((skill) => {
									const badge = referencedSkillBadge(skill.status);
									return (
										<tr key={skill.key}>
											<td className="rc-agent-name" title={skill.name}>
												{skill.name}
											</td>
											<td>{skill.type === "custom" ? "自定义" : "内置"}</td>
											<td>
												<span className={`rc-badge ${badge.cls}`}>
													{badge.spin ? <RefreshCw size={11} aria-hidden="true" className="rc-spin" /> : null}
													{badge.text}
												</span>
											</td>
											<td className="rc-dim">{compactList(skill.declaredBy)}</td>
											<td className="rc-mono">
												{skill.latestVersion ?? "—"}
												{skill.providerCode ? <span className="rc-dim"> · {shortId(skill.providerCode)}</span> : null}
											</td>
											<td className="rc-row-actions">
												{skill.type === "custom" && skill.providerCode ? (
													<button
														className="icon-btn danger"
														type="button"
														aria-label={`删除引用 Skill ${skill.name}`}
														title="删除此自定义 Skill"
														disabled={deletingSkillId === skill.providerCode || skill.status === "checking"}
														onClick={() => void handleDeleteReferencedSkill(skill)}
													>
														<Trash2 size={13} aria-hidden="true" />
													</button>
												) : (
													<span className="rc-dim">—</span>
												)}
											</td>
										</tr>
									);
								})}
								{!loading && view && referencedSkills.length === 0 ? (
									<tr>
										<td colSpan={6} className="rc-empty">
											当前玩法未声明 Skill。
										</td>
									</tr>
								) : null}
								{loading && !view ? <LoadingRows cols={6} /> : null}
							</tbody>
						</table>
					</div>
				</div>
				<div className="rc-reference-block">
					<div className="rc-reference-title">MCP 引用</div>
					<div className="rc-table-wrap">
						<table>
							<thead>
								<tr>
									<th>名称</th>
									<th>类型</th>
									<th>状态</th>
									<th>声明玩法</th>
									<th>挂载 / 缺失</th>
								</tr>
							</thead>
							<tbody>
								{referencedMcpServers.map((server) => {
									const badge = referencedMcpBadge(server.status);
									return (
										<tr key={server.key}>
											<td className="rc-agent-name" title={server.name}>
												{server.name}
											</td>
											<td>{server.type === "official" ? "内置" : "自定义"}</td>
											<td>
												<span className={`rc-badge ${badge.cls}`}>{badge.text}</span>
											</td>
											<td className="rc-dim">{compactList(server.declaredBy)}</td>
											<td className="rc-dim">
												{server.status === "extra"
													? compactList(server.attachedAgents)
													: `${server.attachedAgents.length} 已挂载 / ${server.missingAgents.length} 缺失`}
											</td>
										</tr>
									);
								})}
								{!loading && view && referencedMcpServers.length === 0 ? (
									<tr>
										<td colSpan={5} className="rc-empty">
											当前玩法未声明 MCP。
										</td>
									</tr>
								) : null}
								{loading && !view ? <LoadingRows cols={5} /> : null}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		</section>
	);
}

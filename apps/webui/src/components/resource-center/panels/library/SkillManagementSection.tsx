import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import Tooltip from "@/components/Tooltip";
import { confirmDialog } from "@/lib/confirm-dialog";
import type { ResourceCenterView, ResourceSkillRow } from "@/lib/domain/resource-center";
import { deleteSkill, uploadSkill } from "@/lib/domain/skill-api";
import { useRc } from "../../context";
import { withReferencedResources } from "../../hooks/useResourceCenter";
import { useSelectionSet } from "../../hooks/useSelectionSet";
import type { PendingSkillUpload } from "../../hooks/useSkillScanPoll";
import { skillStatusBadge } from "../../shared/badges";
import { fmtTime, shortId } from "../../shared/formatters";
import { LoadingRows } from "../../shared/LoadingRows";

export function SkillManagementSection() {
	const {
		view,
		loading,
		setError,
		refresh,
		updateView,
		refreshingSkills,
		refreshSkills,
		pendingSkillUploads,
		addPendingUpload,
		dismissPendingUpload,
	} = useRc();
	const [skillTab, setSkillTab] = useState<"custom" | "official">("custom");
	const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);
	const [bulkDeletingSkills, setBulkDeletingSkills] = useState(false);
	const [uploadingSkill, setUploadingSkill] = useState(false);
	const skillInputRef = useRef<HTMLInputElement>(null);
	const { selected: selectedSkillIds, toggle, toggleAll, clear, removeMany } = useSelectionSet();

	const skills = view?.skills ?? [];
	const officialSkills = view?.officialSkills ?? [];
	const deletableSkills = skills.filter((s) => s.status !== "checking");
	const skillIds = deletableSkills.map((s) => s.id);
	const selectedSkills = deletableSkills.filter((s) => selectedSkillIds.has(s.id));
	const allSkillsSelected = deletableSkills.length > 0 && selectedSkills.length === deletableSkills.length;
	const someSkillsSelected = selectedSkills.length > 0;

	const handleUploadSkill = useCallback(
		async (picked: FileList | File[]) => {
			const file = Array.from(picked)[0];
			if (!file) return;
			if (!file.name.toLowerCase().endsWith(".zip")) {
				setError("Skill 需为 .zip 压缩包。");
				return;
			}
			setUploadingSkill(true);
			setError(null);
			try {
				const result = await uploadSkill(file);
				if (result.kind === "created") {
					refresh();
				} else {
					addPendingUpload({
						fileId: result.fileId,
						filename: result.filename,
						status: "checking",
						startedAt: Date.now(),
					});
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : "上传 Skill 失败");
			} finally {
				setUploadingSkill(false);
			}
		},
		[setError, refresh, addPendingUpload],
	);

	const handleDeleteSkill = useCallback(
		async (skill: Pick<ResourceSkillRow, "id" | "name">) => {
			const ok = await confirmDialog({
				title: `删除 Skill「${skill.name}」？`,
				message: `线上 ID ${skill.id}。删除后该 Skill 不可恢复；已引用它的历史会话不受影响。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingSkillId(skill.id);
			setError(null);
			try {
				await deleteSkill(skill.id);
			} catch (e) {
				setError(e instanceof Error ? e.message : "删除 Skill 失败");
				return;
			} finally {
				setDeletingSkillId(null);
			}
			updateView((prev) => withReferencedResources({ ...prev, skills: prev.skills.filter((s) => s.id !== skill.id) }));
			refresh();
		},
		[setError, updateView, refresh],
	);

	const handleBulkDeleteSkills = useCallback(
		async (targets: ResourceSkillRow[]) => {
			if (targets.length === 0) return;
			const ok = await confirmDialog({
				title: `删除选中的 ${targets.length} 个 Skill？`,
				message: "这些 Skill 将不可恢复；已引用它们的历史会话不受影响。",
				confirmText: `删除 ${targets.length} 个`,
				danger: true,
			});
			if (!ok) return;
			setBulkDeletingSkills(true);
			setError(null);
			const results = await Promise.allSettled(targets.map((skill) => deleteSkill(skill.id).then(() => skill.id)));
			const deleted = new Set(
				results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value),
			);
			const failed = results.length - deleted.size;
			setBulkDeletingSkills(false);
			updateView((prev) => withReferencedResources({ ...prev, skills: prev.skills.filter((s) => !deleted.has(s.id)) }));
			removeMany(deleted);
			if (failed > 0) setError(`${failed} 个 Skill 删除失败，请重试。`);
			refresh();
		},
		[setError, updateView, refresh, removeMany],
	);

	return (
		<section className="rc-panel" aria-label="Skill 管理">
			<div className="rc-panel-head">
				<div>
					<div className="rc-panel-title">Workspace Skill</div>
					<div className="rc-panel-sub">
						{skillTab === "custom"
							? "工作空间自定义 Skill（name 全局唯一）· 可被当前玩法引用"
							: "百炼内置 Skill · provider catalog（只读）"}
					</div>
				</div>
				<div className="rc-bulk-bar">
					{skillTab === "custom" && someSkillsSelected ? (
						<>
							<span className="rc-dim">已选 {selectedSkills.length} 项</span>
							<button className="pill-btn" type="button" onClick={clear} disabled={bulkDeletingSkills}>
								取消选择
							</button>
							<button
								className="pill-btn danger"
								type="button"
								onClick={() => void handleBulkDeleteSkills(selectedSkills)}
								disabled={bulkDeletingSkills}
							>
								<Trash2 size={14} aria-hidden="true" />
								{bulkDeletingSkills ? "删除中…" : `批量删除 ${selectedSkills.length}`}
							</button>
						</>
					) : null}
					<button
						className={`pill-control${skillTab === "custom" ? " active" : ""}`}
						type="button"
						onClick={() => setSkillTab("custom")}
					>
						自定义 {skills.length}
					</button>
					<button
						className={`pill-control${skillTab === "official" ? " active" : ""}`}
						type="button"
						onClick={() => setSkillTab("official")}
					>
						内置 {officialSkills.length}
					</button>
					{skillTab === "custom" ? (
						<>
							<input
								ref={skillInputRef}
								type="file"
								hidden
								aria-label="上传 Skill"
								accept=".zip"
								onChange={(e) => {
									if (e.target.files) void handleUploadSkill(e.target.files);
									e.target.value = "";
								}}
							/>
							<button
								className="pill-btn"
								type="button"
								onClick={() => skillInputRef.current?.click()}
								disabled={uploadingSkill}
							>
								<Plus size={14} aria-hidden="true" />
								{uploadingSkill ? "上传中…" : "上传 Skill"}
							</button>
						</>
					) : null}
					<button
						className="icon-btn"
						type="button"
						aria-label="刷新 Skill"
						title="刷新 Skill"
						onClick={() => void refreshSkills()}
						disabled={loading || refreshingSkills}
					>
						<RefreshCw size={14} aria-hidden="true" className={loading || refreshingSkills ? "rc-spin" : undefined} />
					</button>
				</div>
			</div>
			{skillTab === "custom" ? (
				<CustomSkillTable
					skills={skills}
					loading={loading}
					view={view}
					selectedSkillIds={selectedSkillIds}
					deletingSkillId={deletingSkillId}
					toggle={toggle}
					toggleAll={toggleAll}
					skillIds={skillIds}
					deletableSkills={deletableSkills}
					allSkillsSelected={allSkillsSelected}
					someSkillsSelected={someSkillsSelected}
					pendingSkillUploads={pendingSkillUploads}
					dismissPendingUpload={dismissPendingUpload}
					onDelete={handleDeleteSkill}
				/>
			) : (
				<OfficialSkillTable skills={officialSkills} loading={loading} view={view} />
			)}
		</section>
	);
}

function CustomSkillTable({
	skills,
	loading,
	view,
	selectedSkillIds,
	deletingSkillId,
	toggle,
	toggleAll,
	skillIds,
	deletableSkills,
	allSkillsSelected,
	someSkillsSelected,
	pendingSkillUploads,
	dismissPendingUpload,
	onDelete,
}: {
	skills: ResourceSkillRow[];
	loading: boolean;
	view: ResourceCenterView | null;
	selectedSkillIds: Set<string>;
	deletingSkillId: string | null;
	toggle: (id: string) => void;
	toggleAll: (ids: string[], select: boolean) => void;
	skillIds: string[];
	deletableSkills: ResourceSkillRow[];
	allSkillsSelected: boolean;
	someSkillsSelected: boolean;
	pendingSkillUploads: PendingSkillUpload[];
	dismissPendingUpload: (fileId: string) => void;
	onDelete: (skill: Pick<ResourceSkillRow, "id" | "name">) => void;
}) {
	return (
		<div className="rc-table-wrap">
			<table>
				<thead>
					<tr>
						<th className="rc-check-col">
							<input
								type="checkbox"
								aria-label="全选 Skill"
								checked={allSkillsSelected}
								ref={(el) => {
									if (el) el.indeterminate = someSkillsSelected && !allSkillsSelected;
								}}
								onChange={(e) => toggleAll(skillIds, e.target.checked)}
								disabled={deletableSkills.length === 0}
							/>
						</th>
						<th>名称</th>
						<th>描述</th>
						<th>状态</th>
						<th>最新版本</th>
						<th>更新时间</th>
						<th>线上 ID</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{pendingSkillUploads.map((pending) => (
						<tr key={`pending-${pending.fileId}`}>
							<td className="rc-check-col" aria-label="待处理" />
							<td className="rc-agent-name" title={pending.filename.replace(/\.zip$/i, "")}>
								{pending.filename.replace(/\.zip$/i, "")}
							</td>
							<td className="rc-dim">—</td>
							<td>
								{pending.status === "error" ? (
									<Tooltip text={pending.error} className="rc-badge none">
										上传失败
									</Tooltip>
								) : (
									<span className="rc-badge agents">
										<RefreshCw size={11} aria-hidden="true" className="rc-spin" />
										{pending.status === "creating" ? "创建中" : "审核中"}
									</span>
								)}
							</td>
							<td className="rc-dim">—</td>
							<td className="rc-dim">—</td>
							<td className="rc-mono">—</td>
							<td className="rc-row-actions">
								{pending.status === "error" ? (
									<button
										className="icon-btn"
										type="button"
										aria-label={`移除 ${pending.filename}`}
										title="移除"
										onClick={() => dismissPendingUpload(pending.fileId)}
									>
										<X size={13} aria-hidden="true" />
									</button>
								) : null}
							</td>
						</tr>
					))}
					{skills.map((skill) => {
						const badge = skillStatusBadge(skill.status);
						const scanning = skill.status === "checking";
						const checked = selectedSkillIds.has(skill.id);
						return (
							<tr key={skill.id} className={checked ? "selected" : ""}>
								<td className="rc-check-col">
									<input
										type="checkbox"
										aria-label={`选择 Skill ${skill.name}`}
										checked={checked}
										onChange={() => toggle(skill.id)}
										disabled={scanning}
									/>
								</td>
								<td className="rc-agent-name" title={skill.name}>
									{skill.name}
								</td>
								<td className="rc-dim">
									<Tooltip text={skill.raw.description ?? undefined} className="rc-desc">
										{skill.raw.description ?? "—"}
									</Tooltip>
								</td>
								<td>
									<span className={`rc-badge ${badge.cls}`}>
										{badge.spin ? <RefreshCw size={11} aria-hidden="true" className="rc-spin" /> : null}
										{badge.text}
									</span>
								</td>
								<td className="rc-dim">{skill.latestVersion ?? "—"}</td>
								<td className="rc-dim">{fmtTime(skill.updatedAt)}</td>
								<td className="rc-mono">{shortId(skill.id)}</td>
								<td className="rc-row-actions">
									<button
										className="icon-btn danger"
										type="button"
										aria-label={`删除 Skill ${skill.name}`}
										title={scanning ? "扫描中,暂不可删除" : "删除此 Skill"}
										disabled={scanning || deletingSkillId === skill.id}
										onClick={() => onDelete(skill)}
									>
										<Trash2 size={13} aria-hidden="true" />
									</button>
								</td>
							</tr>
						);
					})}
					{!loading && view && skills.length === 0 && pendingSkillUploads.length === 0 ? (
						<tr>
							<td colSpan={8} className="rc-empty">
								<div className="rc-empty-title">暂无 Workspace Skill</div>
								<div className="rc-empty-desc">
									点击右上角「上传 Skill」添加 .zip 压缩包，name 将作为工作空间唯一键。
								</div>
							</td>
						</tr>
					) : null}
					{loading && !view ? <LoadingRows cols={8} /> : null}
				</tbody>
			</table>
		</div>
	);
}

function OfficialSkillTable({
	skills,
	loading,
	view,
}: {
	skills: ResourceSkillRow[];
	loading: boolean;
	view: ResourceCenterView | null;
}) {
	return (
		<div className="rc-table-wrap">
			<table>
				<thead>
					<tr>
						<th>名称</th>
						<th>描述</th>
						<th>最新版本</th>
						<th>线上 ID</th>
					</tr>
				</thead>
				<tbody>
					{skills.map((skill) => (
						<tr key={skill.id}>
							<td className="rc-agent-name" title={skill.name}>
								{skill.name}
							</td>
							<td className="rc-dim">
								<Tooltip text={skill.raw.description ?? undefined} className="rc-desc">
									{skill.raw.description ?? "—"}
								</Tooltip>
							</td>
							<td className="rc-dim">{skill.latestVersion ?? "—"}</td>
							<td className="rc-mono">{shortId(skill.id)}</td>
						</tr>
					))}
					{!loading && view && skills.length === 0 ? (
						<tr>
							<td colSpan={4} className="rc-empty">
								<div className="rc-empty-title">暂无内置 Skill</div>
								<div className="rc-empty-desc">当前 workspace 未提供内置 Skill。</div>
							</td>
						</tr>
					) : null}
					{loading && !view ? <LoadingRows cols={4} /> : null}
				</tbody>
			</table>
		</div>
	);
}

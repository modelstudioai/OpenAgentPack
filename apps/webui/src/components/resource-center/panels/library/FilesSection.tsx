import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { confirmDialog } from "@/lib/confirm-dialog";
import { deleteFile, uploadFile } from "@/lib/domain/file-api";
import type { ResourceFileRow } from "@/lib/domain/resource-center";
import { ACCEPTED_FILE_TYPES } from "@/lib/hooks/useFileUploads";
import { useRc } from "../../context";
import { useSelectionSet } from "../../hooks/useSelectionSet";
import { fileStatusBadge } from "../../shared/badges";
import { fmtTime, formatBytes, shortId } from "../../shared/formatters";
import { LoadingRows } from "../../shared/LoadingRows";

export function FilesSection() {
	const { view, loading, setError, updateView, refresh, refreshingFiles, refreshFiles } = useRc();
	const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
	const [bulkDeletingFiles, setBulkDeletingFiles] = useState(false);
	const [uploadingFiles, setUploadingFiles] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { selected: selectedFileIds, toggle, toggleAll, clear, remove, removeMany } = useSelectionSet();

	const files = view?.files ?? [];
	const fileIds = files.map((f) => f.id);
	const selectedFiles = files.filter((f) => selectedFileIds.has(f.id));
	const allFilesSelected = files.length > 0 && selectedFiles.length === files.length;
	const someFilesSelected = selectedFiles.length > 0;

	const handleUploadFiles = useCallback(
		async (picked: FileList | File[]) => {
			const list = Array.from(picked);
			if (list.length === 0) return;
			setUploadingFiles(true);
			setError(null);
			const results = await Promise.allSettled(list.map((f) => uploadFile(f)));
			setUploadingFiles(false);
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) setError(`${failed} 个文件上传失败，请重试。`);
			refresh();
		},
		[setError, refresh],
	);

	const handleDeleteFile = useCallback(
		async (file: ResourceFileRow) => {
			const ok = await confirmDialog({
				title: `删除文件「${file.name}」？`,
				message: `线上 ID ${file.id}。删除后该文件不可恢复；已绑定它的历史会话不受影响。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingFileId(file.id);
			setError(null);
			try {
				await deleteFile(file.id);
			} catch (e) {
				setError(e instanceof Error ? e.message : "删除文件失败");
				return;
			} finally {
				setDeletingFileId(null);
			}
			updateView((prev) => ({ ...prev, files: prev.files.filter((f) => f.id !== file.id) }));
			remove(file.id);
			refresh();
		},
		[setError, updateView, refresh, remove],
	);

	const handleBulkDeleteFiles = useCallback(
		async (targets: ResourceFileRow[]) => {
			if (targets.length === 0) return;
			const ok = await confirmDialog({
				title: `删除选中的 ${targets.length} 个文件？`,
				message: "这些文件将不可恢复；已绑定它们的历史会话不受影响。",
				confirmText: `删除 ${targets.length} 个`,
				danger: true,
			});
			if (!ok) return;
			setBulkDeletingFiles(true);
			setError(null);
			const results = await Promise.allSettled(targets.map((file) => deleteFile(file.id).then(() => file.id)));
			const deleted = new Set(
				results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value),
			);
			const failed = results.length - deleted.size;
			setBulkDeletingFiles(false);
			updateView((prev) => ({ ...prev, files: prev.files.filter((f) => !deleted.has(f.id)) }));
			removeMany(deleted);
			if (failed > 0) setError(`${failed} 个文件删除失败，请重试。`);
			refresh();
		},
		[setError, updateView, refresh, removeMany],
	);

	return (
		<section className="rc-panel" aria-label="文件">
			<div className="rc-panel-head">
				<div>
					<div className="rc-panel-title">文件</div>
					<div className="rc-panel-sub">本项目上传的文件(Agents__ 前缀隔离) · 最新在前</div>
				</div>
				<div className="rc-bulk-bar">
					{someFilesSelected ? (
						<>
							<span className="rc-dim">已选 {selectedFiles.length} 项</span>
							<button className="pill-btn" type="button" onClick={clear} disabled={bulkDeletingFiles}>
								取消选择
							</button>
							<button
								className="pill-btn danger"
								type="button"
								onClick={() => void handleBulkDeleteFiles(selectedFiles)}
								disabled={bulkDeletingFiles}
							>
								<Trash2 size={14} aria-hidden="true" />
								{bulkDeletingFiles ? "删除中…" : `批量删除 ${selectedFiles.length}`}
							</button>
						</>
					) : null}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						aria-label="上传文件"
						accept={ACCEPTED_FILE_TYPES}
						onChange={(e) => {
							if (e.target.files) void handleUploadFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<button
						className="pill-btn"
						type="button"
						onClick={() => fileInputRef.current?.click()}
						disabled={uploadingFiles}
					>
						<Plus size={14} aria-hidden="true" />
						{uploadingFiles ? "上传中…" : "上传文件"}
					</button>
					<button
						className="icon-btn"
						type="button"
						aria-label="刷新文件"
						title="刷新文件"
						onClick={() => void refreshFiles()}
						disabled={loading || refreshingFiles}
					>
						<RefreshCw size={14} aria-hidden="true" className={loading || refreshingFiles ? "rc-spin" : undefined} />
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
									aria-label="全选文件"
									checked={allFilesSelected}
									ref={(el) => {
										if (el) el.indeterminate = someFilesSelected && !allFilesSelected;
									}}
									onChange={(e) => toggleAll(fileIds, e.target.checked)}
									disabled={files.length === 0}
								/>
							</th>
							<th>文件名</th>
							<th>类型</th>
							<th>大小</th>
							<th>状态</th>
							<th>创建时间</th>
							<th>线上 ID</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{files.map((file) => {
							const badge = fileStatusBadge(file);
							const checked = selectedFileIds.has(file.id);
							return (
								<tr key={file.id} className={checked ? "selected" : ""}>
									<td className="rc-check-col">
										<input
											type="checkbox"
											aria-label={`选择文件 ${file.name}`}
											checked={checked}
											onChange={() => toggle(file.id)}
										/>
									</td>
									<td className="rc-agent-name" title={file.name}>
										{file.name}
									</td>
									<td className="rc-dim">{file.mimeType ?? "—"}</td>
									<td className="num">{formatBytes(file.sizeBytes)}</td>
									<td>
										<span className={`rc-badge ${badge.cls}`}>{badge.text}</span>
									</td>
									<td className="rc-dim">{fmtTime(file.createdAt)}</td>
									<td className="rc-mono">{shortId(file.id)}</td>
									<td className="rc-row-actions">
										<button
											className="icon-btn danger"
											type="button"
											aria-label={`删除文件 ${file.name}`}
											title="删除此文件"
											disabled={deletingFileId === file.id}
											onClick={() => void handleDeleteFile(file)}
										>
											<Trash2 size={13} aria-hidden="true" />
										</button>
									</td>
								</tr>
							);
						})}
						{!loading && view && files.length === 0 ? (
							<tr>
								<td colSpan={8} className="rc-empty">
									<div className="rc-empty-title">暂无文件</div>
									<div className="rc-empty-desc">点击右上角「上传文件」添加文件,可在创建任务时绑定到会话。</div>
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

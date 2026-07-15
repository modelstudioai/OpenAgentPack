import { AlertCircle, Loader2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type FileStatusInfo,
	getFileStatuses,
	listFiles,
	type UploadedFile as ServerFile,
	stripPrefix,
	uploadFile,
} from "@/lib/domain/file-api";
import { ACCEPTED_FILE_TYPES } from "@/lib/hooks/useFileUploads";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { FileTypeIcon } from "./FileTypeIcon";

interface FilePickerModalProps {
	open: boolean;
	onClose: () => void;
	onConfirm: (selected: ServerFile[]) => void;
	initialSelectedIds?: string[];
}

// A local upload still in flight (no server row yet). Errors keep the row visible so the user
// sees the failure; success is dropped once the file surfaces in the refreshed server list.
interface PendingUpload {
	localId: string;
	name: string;
	status: "uploading" | "error";
	error?: string;
}

function formatBytes(bytes: number): string {
	if (!bytes) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 只有服务端归一化后的 `status` 才能细分失败原因；`available` 由 file-lifecycle 统一推导。
function statusBadge(file: ServerFile): { text: string; cls: string; loading?: boolean } | null {
	if (file.available) return null;
	switch (file.status) {
		case "rejected":
			return { text: "未通过", cls: "none" };
		case "type_rejected":
			return { text: "格式错误", cls: "none" };
		case "checking":
			return { text: "检测中", cls: "agents", loading: true };
		default:
			return { text: "扫描中", cls: "agents", loading: true };
	}
}

// The file list and its loading status form one async-fetch unit; a reducer keeps the list,
// in-flight uploads, loading flag, and error as a single coherent transition.
interface ListState {
	files: ServerFile[];
	pending: PendingUpload[];
	loading: boolean;
	error: string | null;
}

type ListAction =
	| { type: "loadStart" }
	| { type: "loadOk"; files: ServerFile[] }
	| { type: "loadErr"; error: string }
	| { type: "patchStatuses"; updates: Map<string, FileStatusInfo> }
	| { type: "addPending"; upload: PendingUpload }
	| { type: "removePending"; localId: string }
	| { type: "failPending"; localId: string; error: string };

function listReducer(state: ListState, action: ListAction): ListState {
	switch (action.type) {
		case "loadStart":
			return { ...state, loading: true, error: null };
		case "loadOk":
			return { ...state, loading: false, files: action.files };
		case "loadErr":
			return { ...state, loading: false, error: action.error };
		case "patchStatuses":
			return {
				...state,
				files: state.files.map((f) => {
					const patch = action.updates.get(f.id);
					if (!patch) return f;
					const status = patch.status ?? f.status;
					const available = patch.available ?? f.available;
					if (status === f.status && f.available === available) return f;
					return { ...f, status, available };
				}),
			};
		case "addPending":
			return { ...state, pending: [...state.pending, action.upload] };
		case "removePending":
			return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
		case "failPending":
			return {
				...state,
				pending: state.pending.map((p) =>
					p.localId === action.localId ? { ...p, status: "error", error: action.error } : p,
				),
			};
	}
}

export default function FilePickerModal({ open, onClose, onConfirm, initialSelectedIds }: FilePickerModalProps) {
	// 父组件按 `open` 切换给本组件传 key 触发重挂载，因此初始 state 直接由 props 推导即为「每次打开复位」。
	const [list, dispatch] = useReducer(listReducer, { files: [], pending: [], loading: false, error: null });
	const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds ?? []));
	const [query, setQuery] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);
	// fileIds the user just uploaded — auto-selected the moment they turn available. Lazily created
	// so the `new Set()` isn't rebuilt and discarded on every render.
	const autoSelectRef = useRef<Set<string> | null>(null);
	const getAutoSelect = useCallback(() => {
		autoSelectRef.current ??= new Set();
		return autoSelectRef.current;
	}, []);
	// Latest files list, read inside the poll tick so the interval depends only on `open`.
	const filesRef = useRef(list.files);
	filesRef.current = list.files;

	useBodyScrollLock(open);

	const refresh = useCallback(async () => {
		dispatch({ type: "loadStart" });
		try {
			const fetched = await listFiles();
			dispatch({ type: "loadOk", files: fetched });
		} catch (error) {
			dispatch({ type: "loadErr", error: error instanceof Error ? error.message : String(error) });
		}
	}, []);

	// Load the project list each time the modal opens.
	useEffect(() => {
		if (!open) return;
		void refresh();
	}, [open, refresh]);

	// ESC to close. useEffectEvent keeps the latest onClose without re-subscribing the listener.
	const onEscClose = useEffectEvent(() => onClose());
	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onEscClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open]);

	// Poll the scan status of not-yet-available files so freshly uploaded rows flip to selectable
	// without a manual refresh. Reads the latest list via ref so the timer starts once per open.
	// `auto.delete(...)` below is Set.prototype.delete (membership cleanup), not a network DELETE —
	// react-doctor's no-effect-event-handler mistakes the method name for one, so the disable marks
	// a true false positive: this is a lifecycle poll keyed on `open`, not an event handler.
	// oxlint-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (!open) return;
		const timer = setInterval(async () => {
			const pendingIds: string[] = [];
			for (const f of filesRef.current) {
				if (!f.available) pendingIds.push(f.id);
			}
			if (pendingIds.length === 0) return;
			try {
				const infos = await getFileStatuses(pendingIds);
				if (infos.length === 0) return;
				const updates = new Map(infos.map((i) => [i.id, i]));
				// Files the user just uploaded that turned available this tick → auto-select them.
				autoSelectRef.current ??= new Set();
				const auto = autoSelectRef.current;
				const newlySelected: string[] = [];
				for (const f of filesRef.current) {
					if (updates.get(f.id)?.available && auto.has(f.id)) {
						auto.delete(f.id);
						newlySelected.push(f.id);
					}
				}
				dispatch({ type: "patchStatuses", updates });
				if (newlySelected.length > 0) {
					setSelected((s) => {
						const next = new Set(s);
						for (const id of newlySelected) next.add(id);
						return next;
					});
				}
			} catch {
				// Transient status poll failure — keep the existing rows and retry next tick.
			}
		}, 2500);
		return () => clearInterval(timer);
	}, [open]);

	const handleUpload = useCallback(
		(picked: FileList | File[]) => {
			for (const file of Array.from(picked)) {
				const localId = Math.random().toString(36).slice(2, 10);
				dispatch({ type: "addPending", upload: { localId, name: file.name, status: "uploading" } });
				uploadFile(file)
					.then((result) => {
						// Newly uploaded → auto-select once its scan reaches `available`.
						getAutoSelect().add(result.id);
						dispatch({ type: "removePending", localId });
						void refresh();
					})
					.catch((error) => {
						dispatch({
							type: "failPending",
							localId,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
		},
		[refresh, getAutoSelect],
	);

	const toggle = useCallback((file: ServerFile) => {
		if (!file.available) return;
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(file.id)) next.delete(file.id);
			else next.add(file.id);
			return next;
		});
	}, []);

	const visibleFiles = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return list.files;
		return list.files.filter((f) => stripPrefix(f.filename).toLowerCase().includes(q));
	}, [list.files, query]);

	const confirm = useCallback(() => {
		const chosen = list.files.filter((f) => selected.has(f.id));
		onConfirm(chosen);
		onClose();
	}, [list.files, selected, onConfirm, onClose]);

	if (!open) return null;

	const isEmpty = !list.loading && visibleFiles.length === 0 && list.pending.length === 0;

	return createPortal(
		<div className="case-modal-overlay">
			<div className="fp-modal">
				<button className="case-modal-close" onClick={onClose} type="button" aria-label="关闭">
					<X size={16} />
				</button>
				<div className="fp-header">
					<h3 className="case-modal-title">选择文件</h3>
					<div className="fp-toolbar">
						<div className="fp-search">
							<Search size={15} />
							<input
								type="text"
								placeholder="搜索文件名"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								aria-label="搜索文件名"
							/>
						</div>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							hidden
							aria-label="上传文件"
							accept={ACCEPTED_FILE_TYPES}
							onChange={(e) => {
								if (e.target.files) handleUpload(e.target.files);
								e.target.value = "";
							}}
						/>
						<button className="pill-btn" type="button" onClick={() => fileInputRef.current?.click()}>
							<Plus size={16} />
							<span>上传</span>
						</button>
					</div>
				</div>

				<div className="fp-list">
					{list.loading && list.files.length === 0 && (
						<div className="fp-state">
							<Loader2 size={18} className="spin" />
							<span>加载中…</span>
						</div>
					)}
					{list.error && <div className="fp-state fp-state-error">{list.error}</div>}
					{isEmpty && !list.error && <div className="fp-state">暂无文件，点击「上传」添加</div>}

					{list.pending.map((p) => (
						<div key={p.localId} className={`fp-row is-disabled ${p.status === "error" ? "is-error" : ""}`}>
							<span className="fp-row-icon">
								{p.status === "error" ? <AlertCircle size={16} /> : <Loader2 size={16} className="spin" />}
							</span>
							<span className="fp-row-name">{stripPrefix(p.name)}</span>
							<span className="fp-row-meta">{p.status === "error" ? (p.error ?? "上传失败") : "上传中…"}</span>
						</div>
					))}

					{visibleFiles.map((file) => {
						const badge = statusBadge(file);
						const checked = selected.has(file.id);
						return (
							<button
								key={file.id}
								type="button"
								className={`fp-row ${file.available ? "" : "is-disabled"} ${checked ? "is-selected" : ""}`}
								onClick={() => toggle(file)}
								disabled={!file.available}
							>
								<span className="fp-row-check" aria-hidden>
									{checked ? "✓" : ""}
								</span>
								<span className="fp-row-icon">
									<FileTypeIcon mimeType={file.mime_type} filename={file.filename} />
								</span>
								<span className="fp-row-name">{stripPrefix(file.filename)}</span>
								<span className="fp-row-meta">{formatBytes(file.size_bytes ?? 0)}</span>
								{badge && (
									<span className={`rc-badge ${badge.cls}`}>
										{badge.loading && <Loader2 size={11} className="spin" />}
										{badge.text}
									</span>
								)}
							</button>
						);
					})}
				</div>

				<div className="fp-footer">
					<span className="fp-footer-count">已选 {selected.size} 个</span>
					<div className="fp-footer-actions">
						<button className="pill-btn" type="button" onClick={onClose}>
							取消
						</button>
						<button className="pill-btn primary" type="button" onClick={confirm} disabled={selected.size === 0}>
							确定
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

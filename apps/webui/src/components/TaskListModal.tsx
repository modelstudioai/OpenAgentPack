import { FileText, Image, Inbox, LayoutGrid, Loader2, Search, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientTask } from "@/lib/store/task-client-store";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";

type Task = ClientTask;

const typeIcons: Record<Task["type"], React.ComponentType<{ size?: number }>> = {
	text: FileText,
	video: Video,
	image: Image,
	app: LayoutGrid,
};

function formatDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function isRecent(ts: number): boolean {
	return Date.now() - ts < 30 * 24 * 60 * 60 * 1000;
}

interface TaskListModalProps {
	tasks: Task[];
	isLoading: boolean;
	error: string | null;
	deletingId: string | null;
	onSelect: (task: Task) => void;
	onDelete: (task: Task) => void;
	onClose: () => void;
	onReload: () => void;
}

export default function TaskListModal({
	tasks,
	isLoading,
	error,
	deletingId,
	onSelect,
	onDelete,
	onClose,
	onReload,
}: TaskListModalProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	useBodyScrollLock(true);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [onClose]);

	useEffect(() => {
		const timer = setTimeout(() => searchRef.current?.focus(), 100);
		return () => clearTimeout(timer);
	}, []);

	const totalCount = tasks.length;
	const filteredTasks = tasks.filter((t) => t.title.toLowerCase().includes(searchQuery.toLowerCase()));
	const recentTasks = filteredTasks.filter((t) => isRecent(t.createdAt));
	const olderTasks = filteredTasks.filter((t) => !isRecent(t.createdAt));

	const renderItem = (task: Task) => {
		const Icon = typeIcons[task.type];
		const isDeleting = deletingId === task.id;
		return (
			<div key={task.id} className={`task-modal-item ${task.status}`}>
				<button type="button" className="task-modal-item-main" onClick={() => onSelect(task)}>
					<span className="task-modal-item-icon">
						<Icon size={16} />
					</span>
					<span className="task-modal-item-title">{task.title}</span>
					{task.status === "running" ? (
						<span className="task-modal-item-running">
							<Loader2 size={13} className="spin" />
							运行中
						</span>
					) : (
						<span className="task-modal-item-date">{formatDate(task.createdAt)}</span>
					)}
					<kbd className="task-modal-item-enter">Enter</kbd>
				</button>
				<button
					type="button"
					className="task-modal-item-delete"
					aria-label="删除任务"
					title="删除任务"
					disabled={isDeleting}
					onClick={() => onDelete(task)}
				>
					{isDeleting ? <Loader2 size={12} className="spin" /> : "Delete"}
				</button>
			</div>
		);
	};

	return createPortal(
		<div className="task-modal-overlay">
			<div className="task-modal">
				<div className="task-modal-search">
					<Search size={18} className="task-search-icon" />
					<input
						ref={searchRef}
						type="text"
						className="task-search-input"
						placeholder="搜索任务..."
						aria-label="搜索任务"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
					/>
					<button type="button" className="task-esc-badge" onClick={onClose}>
						ESC
					</button>
				</div>

				<div className="task-modal-list">
					{totalCount === 0 && (
						<div className="task-modal-empty">
							{isLoading ? (
								<>
									<Loader2 size={30} className="spin" />
									<span>正在加载任务...</span>
								</>
							) : (
								<>
									<Inbox size={32} strokeWidth={1.2} />
									<span>{error || "暂无任务记录"}</span>
								</>
							)}
						</div>
					)}

					{recentTasks.length > 0 && (
						<>
							<div className="task-modal-group-label">最近 30 天</div>
							{recentTasks.map(renderItem)}
						</>
					)}

					{olderTasks.length > 0 && (
						<>
							<div className="task-modal-group-label">更早</div>
							{olderTasks.map(renderItem)}
						</>
					)}

					{error && totalCount > 0 && (
						<div className="task-modal-more">
							<button type="button" className="task-modal-more-btn secondary" onClick={onReload}>
								重新加载
							</button>
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}

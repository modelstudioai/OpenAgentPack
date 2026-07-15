import { FileText } from "lucide-react";
import { forwardRef, useImperativeHandle, useState } from "react";
import { stripPrefix, type UploadedFile } from "@/lib/domain/file-api";

export interface MentionListRef {
	onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface MentionListProps {
	items: UploadedFile[];
	command: (item: { id: string; label: string }) => void;
}

function itemsKey(items: UploadedFile[]): string {
	return items.map((f) => f.id).join(",");
}

/** @ 建议列表（TipTap suggestion 渲染） */
const MentionList = forwardRef<MentionListRef, MentionListProps>(function MentionList({ items, command }, ref) {
	const key = itemsKey(items);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [prevKey, setPrevKey] = useState(key);

	// 过滤结果变化时重置选中项（避免 index 越界）
	if (key !== prevKey) {
		setPrevKey(key);
		setSelectedIndex(0);
	}

	const activeIndex = items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);

	useImperativeHandle(ref, () => ({
		onKeyDown: ({ event }) => {
			if (event.key === "ArrowUp") {
				setSelectedIndex((i) => (i + items.length - 1) % Math.max(items.length, 1));
				return true;
			}
			if (event.key === "ArrowDown") {
				setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
				return true;
			}
			if (event.key === "Enter") {
				const idx = items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);
				const item = items[idx];
				if (item) {
					command({ id: item.id, label: stripPrefix(item.filename) });
				}
				return true;
			}
			return false;
		},
	}));

	if (items.length === 0) {
		return (
			<div className="mention-suggest mention-suggest-empty" role="listbox">
				<span>无匹配文件</span>
			</div>
		);
	}

	return (
		<div className="mention-suggest" role="listbox">
			{items.map((file, index) => {
				const name = stripPrefix(file.filename);
				return (
					<button
						key={file.id}
						type="button"
						className={`mention-suggest-item ${index === activeIndex ? "is-active" : ""}`}
						role="option"
						aria-selected={index === activeIndex}
						onMouseDown={(e) => {
							e.preventDefault();
							command({ id: file.id, label: name });
						}}
					>
						<span className="mention-suggest-icon">
							<FileText size={16} />
						</span>
						<span className="mention-suggest-name">{name}</span>
					</button>
				);
			})}
		</div>
	);
});

export default MentionList;

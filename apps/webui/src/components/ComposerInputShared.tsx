import { ArrowUp, CircleX, Info, Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
	PromptEditorSlot,
	type PromptEditorSlotId,
	usePromptEditor,
} from "@/components/prompt-editor/PromptEditorProvider";
import { stripPrefix } from "@/lib/domain/file-api";
import FilePickerModal from "./FilePickerModal";
import { FileTypeIcon } from "./FileTypeIcon";
import TaskBox from "./TaskBox";

/** 额度提示与任务入口 */
export function ComposerFeeNotice() {
	return (
		<div className="composer-top-row">
			<div className="composer-notice">
				<Info size={11} />
				<span>体验将会消耗账户额度，费用以实际发生为主。</span>
			</div>
			<TaskBox />
		</div>
	);
}

/** 已选文件缩略条 */
export function SelectedFilesStrip() {
	const { selectedFiles, removeFile } = usePromptEditor();

	if (selectedFiles.length === 0) return null;

	return (
		<div className="uploaded-files">
			{selectedFiles.map(({ file }) => {
				const name = stripPrefix(file.filename);
				const ext = name.split(".").pop() || "";
				const baseName = name.replace(/\.[^.]+$/, "");
				const shortName = baseName.length > 6 ? `${baseName.slice(0, 6)}...` : baseName;
				const displayName = ext ? `${shortName}.${ext}` : shortName;
				return (
					<div key={file.id} className="uploaded-file-item" title={name}>
						<span className="uploaded-file-thumb-wrap">
							<span className="uploaded-file-icon">
								<FileTypeIcon mimeType={file.mime_type} filename={file.filename} />
							</span>
						</span>
						<span className="uploaded-file-name">{displayName}</span>
						<button className="uploaded-file-remove" type="button" onClick={() => removeFile(file.id)}>
							<CircleX size={10} />
						</button>
					</div>
				);
			})}
		</div>
	);
}

interface PromptGhostEditorProps {
	slotId: PromptEditorSlotId;
	wrapClassName: string;
	editorClassName: string;
	hintRowClassName: string;
	ghostText: string;
	/** 额外 class，例如 BottomBar 轮播的 fade-in / fade-out */
	ghostClassName?: string;
	hasValue: boolean;
}

/** 编辑器 slot + ghost 提示 + Tab 快捷键提示 */
export function PromptGhostEditor({
	slotId,
	wrapClassName,
	editorClassName,
	hintRowClassName,
	ghostText,
	ghostClassName = "",
	hasValue,
}: PromptGhostEditorProps) {
	return (
		<div className={wrapClassName}>
			<PromptEditorSlot slotId={slotId} className={`prompt-editor-slot ${editorClassName}`} />
			<div className={hintRowClassName}>
				<span className={`composer-mobile-placeholder ${hasValue ? "hidden" : ""}`}>输入你的想法</span>
				<span className={`prompt-ghost ${hasValue ? "hidden" : ghostClassName}`.trim()}>{ghostText}</span>
				<span className={`shortcut-hint ${hasValue ? "hidden" : ""}`} aria-hidden="true">
					<kbd>Tab</kbd>
				</span>
			</div>
		</div>
	);
}

interface AttachFilesButtonProps {
	onClick: () => void;
}

/** 打开文件选择器的 + 按钮 */
export function AttachFilesButton({ onClick }: AttachFilesButtonProps) {
	return (
		<button
			className="icon-btn"
			type="button"
			aria-label="选择文件"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
		>
			<Plus size={20} />
		</button>
	);
}

interface ComposerSendButtonProps {
	hasValue: boolean;
	isSubmitting: boolean;
	canSubmit: boolean;
	/** button 的 type，Composer 表单用 submit，BottomBar 用 button */
	type?: "submit" | "button";
	onClick?: () => void;
}

/** 提交任务按钮 */
export function ComposerSendButton({
	hasValue,
	isSubmitting,
	canSubmit,
	type = "button",
	onClick,
}: ComposerSendButtonProps) {
	return (
		<button
			className={`icon-btn send ${hasValue && !isSubmitting && canSubmit ? "ready" : ""}`}
			type={type}
			aria-label="开始体验"
			onClick={onClick}
			disabled={isSubmitting || !hasValue || !canSubmit}
		>
			{isSubmitting ? <Loader2 size={20} className="spin" /> : <ArrowUp size={20} />}
		</button>
	);
}

/** 文件选择器开关与弹层 */
export function useFilePickerModal() {
	const [pickerOpen, setPickerOpen] = useState(false);
	const { selectedFiles, mergePickerConfirm } = usePromptEditor();
	const initialSelectedIds = useMemo(() => selectedFiles.map((e) => e.file.id), [selectedFiles]);

	const openPicker = () => setPickerOpen(true);
	const closePicker = () => setPickerOpen(false);

	const filePickerModal = (
		<FilePickerModal
			key={pickerOpen ? "fp-open" : "fp-closed"}
			open={pickerOpen}
			onClose={closePicker}
			onConfirm={(files) => mergePickerConfirm(files)}
			initialSelectedIds={initialSelectedIds}
		/>
	);

	return { pickerOpen, openPicker, closePicker, filePickerModal };
}

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { usePromptEditor } from "@/components/prompt-editor/PromptEditorProvider";
import type { UiModel } from "@/lib/domain/model-api";
import type { RoleCard } from "@/lib/playbooks/types";
import {
	AttachFilesButton,
	ComposerFeeNotice,
	ComposerSendButton,
	PromptGhostEditor,
	SelectedFilesStrip,
	useFilePickerModal,
} from "./ComposerInputShared";
import ModelSelector from "./ModelSelector";
import TaskBox from "./TaskBox";
import TaskRuntime from "./TaskRuntime";
import { useSubmitTask } from "./useSubmitTask";

export interface ComposerHandle {
	focus: () => void;
	focusStart: () => void;
}

interface ComposerProps {
	inputValue: string;
	onInputChange: (value: string) => void;
	agentId: string;
	roleCards: RoleCard[];
	activeRoleIndex?: number;
	model: string;
	models: UiModel[];
	onModelChange: (modelId: string) => void;
	onMakeSame?: (input: { prompt: string; agentId?: string }) => void;
	canSubmit?: boolean;
	ref?: React.Ref<ComposerHandle>;
}

export default function Composer({
	inputValue,
	onInputChange,
	agentId,
	roleCards,
	activeRoleIndex = 0,
	model,
	models,
	onModelChange,
	onMakeSame,
	canSubmit = true,
	ref,
}: ComposerProps) {
	const [ghostText, setGhostText] = useState("");
	const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { isSubmitting, submitTask } = useSubmitTask();
	const { isEmpty, selectedFiles, clearAll, submitPrompt, setSlotTabFill, editor } = usePromptEditor();
	const { pickerOpen, openPicker, filePickerModal } = useFilePickerModal();

	useImperativeHandle(ref, () => ({
		focus: () => editor?.commands.focus(),
		focusStart: () => editor?.commands.focus("start", { scrollIntoView: false }),
	}));

	const hasValue = !isEmpty || inputValue.length > 0;

	const currentRolePrompt = roleCards[activeRoleIndex]?.prompt || "";
	useEffect(() => {
		setSlotTabFill("composer", currentRolePrompt);
	}, [currentRolePrompt, setSlotTabFill]);

	// 角色卡 prompt 打字机效果；文件选择器打开时暂停，避免频繁重渲染
	useEffect(() => {
		if (!hasValue && !pickerOpen) {
			let i = 0;
			const type = () => {
				setGhostText(currentRolePrompt.slice(0, i));
				if (i < currentRolePrompt.length) {
					i++;
					typeTimerRef.current = setTimeout(type, 30);
				}
			};
			typeTimerRef.current = setTimeout(type, 200);
			return () => {
				if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
			};
		}
		setGhostText("");
	}, [hasValue, pickerOpen, currentRolePrompt]);

	// ⌘K 聚焦输入框
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				editor?.commands.focus();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [editor]);

	const handleSubmit = () => {
		if (!canSubmit) return;
		const prompt = submitPrompt();
		submitTask({ prompt, agentId, model, selectedFiles }, () => {
			onInputChange("");
			clearAll();
		});
	};

	return (
		<>
			<form
				className="composer"
				onSubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
			>
				<ComposerFeeNotice />

				<div className="composer-card-shell">
					<div className="composer-card-inner">
						<div className="composer-add-wrap">
							<AttachFilesButton onClick={openPicker} />
						</div>

						<SelectedFilesStrip />

						<PromptGhostEditor
							slotId="composer"
							wrapClassName="prompt-row"
							editorClassName="prompt-row-editor"
							hintRowClassName="prompt-hint-row"
							ghostText={ghostText}
							hasValue={hasValue}
						/>

						<div className="composer-footer">
							<div className="tool-buttons">
								<AttachFilesButton onClick={openPicker} />
							</div>
							<div className="mode-buttons">
								<ModelSelector models={models} value={model} onChange={onModelChange} />
								<TaskBox />
							</div>
							<div className="composer-send-wrap">
								<ComposerSendButton
									type="submit"
									hasValue={hasValue}
									isSubmitting={isSubmitting}
									canSubmit={canSubmit}
								/>
							</div>
						</div>
					</div>
				</div>
				{filePickerModal}
			</form>
			<TaskRuntime onMakeSame={onMakeSame} />
		</>
	);
}

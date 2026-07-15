import { Plus } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from "react";
import { usePromptEditor } from "@/components/prompt-editor/PromptEditorProvider";
import suggestions from "@/data/suggestions.json";
import type { UiModel } from "@/lib/domain/model-api";
import {
	AttachFilesButton,
	ComposerFeeNotice,
	ComposerSendButton,
	PromptGhostEditor,
	SelectedFilesStrip,
	useFilePickerModal,
} from "./ComposerInputShared";
import ModelSelector from "./ModelSelector";
import { useSubmitTask } from "./useSubmitTask";

export interface BottomBarHandle {
	expand: () => void;
}

interface BottomBarProps {
	inputValue: string;
	onInputChange: (value: string) => void;
	agentId: string;
	model: string;
	models: UiModel[];
	onModelChange: (modelId: string) => void;
	composerRef: React.RefObject<HTMLElement | null>;
	onVisibilityChange: (visible: boolean) => void;
	onMakeSame?: (input: { prompt: string; agentId?: string }) => void;
	canSubmit?: boolean;
	ref?: React.Ref<BottomBarHandle>;
}

// 轮播 ghost：index 与 fade class 同一次淡出→切换，用 reducer 绑成一次过渡
interface GhostState {
	index: number;
	fade: string;
}

function ghostReducer(state: GhostState, action: "fadeOut" | "advance"): GhostState {
	switch (action) {
		case "fadeOut":
			return { ...state, fade: "fade-out" };
		case "advance":
			return { index: (state.index + 1) % suggestions.length, fade: "fade-in" };
		default: {
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}

export default function BottomBar({
	inputValue,
	onInputChange,
	agentId,
	model,
	models,
	onModelChange,
	composerRef,
	onVisibilityChange,
	ref,
	canSubmit = true,
}: BottomBarProps) {
	const [visible, setVisible] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [ghost, dispatchGhost] = useReducer(ghostReducer, { index: 0, fade: "" });
	const barRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const expandedRef = useRef(expanded);
	const bottomBarVisibleRef = useRef(false);
	const { isSubmitting, submitTask } = useSubmitTask();
	const {
		isEmpty,
		selectedFiles,
		clearAll,
		submitPrompt,
		setSlotTabFill,
		setComposerVisible,
		setBottomBarExpanded,
		registerSubmitHandler,
		editor,
	} = usePromptEditor();
	const { openPicker, filePickerModal } = useFilePickerModal();

	useEffect(() => {
		expandedRef.current = expanded;
	}, [expanded]);

	useEffect(() => {
		setBottomBarExpanded(expanded);
	}, [expanded, setBottomBarExpanded]);

	useImperativeHandle(ref, () => ({
		expand: () => setExpanded(true),
	}));

	const hasValue = !isEmpty || inputValue.length > 0;

	useEffect(() => {
		setSlotTabFill("bottomBar", suggestions[ghost.index] ?? "");
	}, [ghost.index, setSlotTabFill]);

	const doSubmit = useCallback(() => {
		if (!canSubmit) return;
		const prompt = submitPrompt();
		submitTask({ prompt, agentId, model, selectedFiles }, () => {
			onInputChange("");
			clearAll();
		});
	}, [canSubmit, submitPrompt, submitTask, agentId, model, selectedFiles, onInputChange, clearAll]);

	useEffect(() => {
		registerSubmitHandler(doSubmit);
		return () => registerSubmitHandler(null);
	}, [doSubmit, registerSubmitHandler]);

	useEffect(() => {
		const composer = composerRef.current;
		if (!composer) return;

		const observer = new IntersectionObserver(
			(entries) => {
				const isComposerVisible = entries[0]?.isIntersecting ?? true;
				setComposerVisible(isComposerVisible);

				const newVisible = !isComposerVisible;
				if (bottomBarVisibleRef.current !== newVisible) {
					bottomBarVisibleRef.current = newVisible;
					setVisible(newVisible);
					onVisibilityChange(newVisible);
				}

				if (isComposerVisible) {
					document.body.classList.remove("scrolled");
					if (expandedRef.current) setExpanded(false);
				} else {
					document.body.classList.add("scrolled");
				}
			},
			{ threshold: 0 },
		);

		// False positive: onVisibilityChange fires from the async IntersectionObserver callback
		// (not synchronously during the effect), and App stores it in a ref (bottomBarVisibleRef)
		// without calling setState — so there is no extra parent render the rule warns about.
		// oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent
		observer.observe(composer);
		return () => {
			observer.disconnect();
			document.body.classList.remove("scrolled");
		};
	}, [composerRef, onVisibilityChange, setComposerVisible]);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest?.(".toast, .task-modal-overlay, .case-modal-overlay, .mention-suggest-portal")) {
				return;
			}
			if (expandedRef.current && barRef.current && !barRef.current.contains(target)) {
				setExpanded(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	useEffect(() => {
		if (hasValue || !expanded) {
			if (timerRef.current) clearInterval(timerRef.current);
			return;
		}

		timerRef.current = setInterval(() => {
			dispatchGhost("fadeOut");
			setTimeout(() => dispatchGhost("advance"), 300);
		}, 3500);

		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [hasValue, expanded]);

	const handleCollapsedClick = () => {
		setExpanded(true);
		setTimeout(() => editor?.commands.focus(), 100);
	};

	return (
		<div ref={barRef} className={`bottom-bar ${visible ? "visible" : ""} ${expanded ? "expanded" : ""}`}>
			<button type="button" className="bottom-bar-collapsed" onClick={handleCollapsedClick}>
				<span className="bar-placeholder">描述一个任务，比如：帮我分析一份 CSV 数据</span>
				<span className="icon-btn" aria-hidden="true" style={{ flexShrink: 0 }}>
					<Plus size={20} />
				</span>
			</button>
			<div className="bottom-bar-expanded">
				<ComposerFeeNotice />
				<SelectedFilesStrip />
				<PromptGhostEditor
					slotId="bottomBar"
					wrapClassName="bar-input-wrap"
					editorClassName="bar-input-wrap-editor"
					hintRowClassName="bar-hint-row"
					ghostText={suggestions[ghost.index] ?? ""}
					ghostClassName={ghost.fade}
					hasValue={hasValue}
				/>
				<div className="bar-footer">
					<div className="bar-tools">
						<AttachFilesButton onClick={openPicker} />
					</div>
					<div className="bar-mode-buttons">
						<ModelSelector models={models} value={model} onChange={onModelChange} />
						<ComposerSendButton
							hasValue={hasValue}
							isSubmitting={isSubmitting}
							canSubmit={canSubmit}
							onClick={doSubmit}
						/>
					</div>
				</div>
			</div>
			{filePickerModal}
		</div>
	);
}

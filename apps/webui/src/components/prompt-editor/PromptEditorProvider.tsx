import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import {
	createContext,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { UploadedFile } from "@/lib/domain/file-api";
import { MentionDeleteExtension } from "@/lib/editor/mention-delete-plugin";
import { createFileMentionExtension } from "@/lib/editor/mention-extension";
import {
	collectMentionFileIds,
	editorToPlainMirror,
	editorToSubmitPrompt,
	plainTextToDocJson,
} from "@/lib/editor/serialize-prompt";
import {
	addSource,
	filesFromEntries,
	mergePickerConfirm,
	reconcileMentionSources,
	removeEntry,
	type SelectedFileEntry,
} from "@/lib/hooks/selected-files";

export type PromptEditorSlotId = "composer" | "bottomBar";
export type ActiveSlot = PromptEditorSlotId | "hidden";

export interface PromptEditorHandle {
	focus: () => void;
	getEditor: () => Editor | null;
}

interface SlotConfig {
	tabFillText: string;
}

interface PromptEditorContextValue {
	editor: Editor | null;
	isEmpty: boolean;
	selectedFiles: SelectedFileEntry[];
	registerSlot: (id: PromptEditorSlotId, el: HTMLDivElement | null) => void;
	setSlotTabFill: (id: PromptEditorSlotId, text: string) => void;
	setComposerVisible: (visible: boolean) => void;
	setBottomBarExpanded: (expanded: boolean) => void;
	addPickerFiles: (files: UploadedFile[]) => void;
	mergePickerConfirm: (files: UploadedFile[]) => void;
	removeFile: (fileId: string) => void;
	clearAll: () => void;
	submitPrompt: () => string;
	activeSlot: ActiveSlot;
	mentionListOpenRef: React.RefObject<boolean>;
	registerSubmitHandler: (handler: (() => void) | null) => void;
}

const PromptEditorContext = createContext<PromptEditorContextValue | null>(null);

export function usePromptEditor(): PromptEditorContextValue {
	const ctx = useContext(PromptEditorContext);
	if (!ctx) throw new Error("usePromptEditor must be used within PromptEditorProvider");
	return ctx;
}

interface PromptEditorProviderProps {
	inputValue: string;
	onInputChange: (value: string) => void;
	onSubmit?: () => void;
	children: ReactNode;
	editorRef?: Ref<PromptEditorHandle>;
}

export function PromptEditorProvider({
	inputValue,
	onInputChange,
	onSubmit,
	children,
	editorRef,
}: PromptEditorProviderProps) {
	const [selectedFiles, setSelectedFiles] = useState<SelectedFileEntry[]>([]);
	const [activeSlot, setActiveSlot] = useState<ActiveSlot>("composer");
	const [isEmpty, setIsEmpty] = useState(true);

	const composerVisibleRef = useRef(true);
	const bottomBarExpandedRef = useRef(false);
	const slotsRef = useRef<Record<PromptEditorSlotId, HTMLDivElement | null>>({ composer: null, bottomBar: null });
	const hiddenSlotRef = useRef<HTMLDivElement | null>(null);
	const editorWrapRef = useRef<HTMLDivElement | null>(null);
	const slotConfigRef = useRef<Record<PromptEditorSlotId, SlotConfig>>({
		composer: { tabFillText: "" },
		bottomBar: { tabFillText: "" },
	});
	const activeSlotRef = useRef<ActiveSlot>("composer");
	const selectedFilesRef = useRef(selectedFiles);
	const onSubmitRef = useRef(onSubmit);
	const submitHandlerRef = useRef<(() => void) | null>(null);
	const onInputChangeRef = useRef(onInputChange);
	const lastExternalValueRef = useRef(inputValue);
	const mentionListOpenRef = useRef(false);
	const editorInstanceRef = useRef<Editor | null>(null);
	const syncingExternalRef = useRef(false);

	selectedFilesRef.current = selectedFiles;
	onSubmitRef.current = onSubmit;
	onInputChangeRef.current = onInputChange;
	activeSlotRef.current = activeSlot;

	const recomputeActiveSlot = useCallback(() => {
		let next: ActiveSlot;
		if (composerVisibleRef.current) {
			next = "composer";
		} else if (bottomBarExpandedRef.current) {
			next = "bottomBar";
		} else {
			next = "hidden";
		}
		setActiveSlot(next);
	}, []);

	const onMentionSelect = useCallback((file: UploadedFile) => {
		setSelectedFiles((prev) => addSource(prev, file, "mention"));
	}, []);

	const extensions = useMemo(
		() => [
			Document,
			Paragraph,
			Text,
			createFileMentionExtension({
				getSelectedEntries: () => selectedFilesRef.current,
				onMentionSelect,
				setMentionListOpen: (open) => {
					mentionListOpenRef.current = open;
				},
			}),
			MentionDeleteExtension,
		],
		[onMentionSelect],
	);

	const editor = useEditor({
		extensions,
		content: "",
		editorProps: {
			attributes: {
				class: "prompt-input prose-editor",
				"aria-label": "体验任务输入",
			},
			handleKeyDown: (_view, event) => {
				if (mentionListOpenRef.current) return false;

				const slot = activeSlotRef.current;

				if (event.key === "Tab" && !event.shiftKey) {
					const ed = editorInstanceRef.current;
					if (!ed?.isEmpty) return false;
					event.preventDefault();
					const fill =
						slot === "bottomBar"
							? slotConfigRef.current.bottomBar.tabFillText
							: slotConfigRef.current.composer.tabFillText;
					if (fill) {
						ed.chain().setContent(plainTextToDocJson(fill)).setTextSelection(1).run();
					}
					return true;
				}

				if (slot === "bottomBar" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					submitHandlerRef.current?.();
					onSubmitRef.current?.();
					return true;
				}

				return false;
			},
		},
		onUpdate: ({ editor: ed }) => {
			if (syncingExternalRef.current) return;
			setIsEmpty(ed.isEmpty);
			const plain = editorToPlainMirror(ed);
			lastExternalValueRef.current = plain;
			onInputChangeRef.current(plain);

			const mentionIds = collectMentionFileIds(ed);
			setSelectedFiles((prev) => reconcileMentionSources(prev, mentionIds));
		},
	});

	editorInstanceRef.current = editor ?? null;

	useImperativeHandle(
		editorRef,
		() => ({
			focus: () => editor?.commands.focus(),
			getEditor: () => editor ?? null,
		}),
		[editor],
	);

	// 外部 → Editor 同步（Role Card / 做同款）
	useEffect(() => {
		if (!editor) return;
		const currentPlain = editorToPlainMirror(editor);
		if (inputValue === lastExternalValueRef.current && inputValue === currentPlain) return;
		if (inputValue === currentPlain) {
			lastExternalValueRef.current = inputValue;
			return;
		}
		syncingExternalRef.current = true;
		editor.commands.setContent(plainTextToDocJson(inputValue), { emitUpdate: false });
		setIsEmpty(editor.isEmpty);
		lastExternalValueRef.current = inputValue;
		syncingExternalRef.current = false;
	}, [inputValue, editor]);

	// Portal：搬运 editor 容器到活跃槽位
	useLayoutEffect(() => {
		const wrap = editorWrapRef.current;
		if (!wrap || !editor) return;

		const target =
			activeSlot === "composer"
				? slotsRef.current.composer
				: activeSlot === "bottomBar"
					? slotsRef.current.bottomBar
					: hiddenSlotRef.current;

		if (!target || wrap.parentElement === target) return;

		const wasFocused = editor.isFocused;
		const { from, to } = editor.state.selection;

		// 移到隐藏槽前先失焦，避免浏览器 scrollIntoView 把页面拉回顶部
		if (activeSlot === "hidden" && wasFocused) {
			editor.view.dom.blur();
		}

		target.appendChild(wrap);

		// 仅在有可见输入槽之间切换时恢复焦点；hidden 槽不参与
		if (wasFocused && activeSlot !== "hidden") {
			requestAnimationFrame(() => {
				editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection({ from, to }).run();
			});
		}
	}, [activeSlot, editor]);

	const registerSlot = useCallback((id: PromptEditorSlotId, el: HTMLDivElement | null) => {
		const previous = slotsRef.current[id];
		const wrap = editorWrapRef.current;
		if (!el && previous && wrap?.parentElement === previous) {
			queueMicrotask(() => {
				if (wrap.parentElement === previous) {
					hiddenSlotRef.current?.appendChild(wrap);
				}
			});
		}
		slotsRef.current[id] = el;
		if (el && wrap && activeSlotRef.current === id) {
			el.appendChild(wrap);
		}
	}, []);

	const setSlotTabFill = useCallback((id: PromptEditorSlotId, text: string) => {
		slotConfigRef.current[id].tabFillText = text;
	}, []);

	const setComposerVisible = useCallback(
		(visible: boolean) => {
			composerVisibleRef.current = visible;
			recomputeActiveSlot();
		},
		[recomputeActiveSlot],
	);

	const setBottomBarExpanded = useCallback(
		(expanded: boolean) => {
			bottomBarExpandedRef.current = expanded;
			recomputeActiveSlot();
		},
		[recomputeActiveSlot],
	);

	const addPickerFiles = useCallback((files: UploadedFile[]) => {
		setSelectedFiles((prev) => {
			let next = prev;
			for (const f of files) {
				next = addSource(next, f, "picker");
			}
			return next;
		});
	}, []);

	const mergePickerConfirmHandler = useCallback((files: UploadedFile[]) => {
		setSelectedFiles((prev) => mergePickerConfirm(prev, files));
	}, []);

	const removeFile = useCallback((fileId: string) => {
		setSelectedFiles((prev) => removeEntry(prev, fileId));
	}, []);

	const clearAll = useCallback(() => {
		editor?.commands.clearContent(true);
		setSelectedFiles([]);
		setIsEmpty(true);
		lastExternalValueRef.current = "";
	}, [editor]);

	const submitPrompt = useCallback((): string => {
		if (!editor) return inputValue.trim();
		return editorToSubmitPrompt(editor, selectedFilesRef.current);
	}, [editor, inputValue]);

	const registerSubmitHandler = useCallback((handler: (() => void) | null) => {
		submitHandlerRef.current = handler;
	}, []);

	const value: PromptEditorContextValue = {
		editor,
		isEmpty,
		selectedFiles,
		registerSlot,
		setSlotTabFill,
		setComposerVisible,
		setBottomBarExpanded,
		addPickerFiles,
		mergePickerConfirm: mergePickerConfirmHandler,
		removeFile,
		clearAll,
		submitPrompt,
		activeSlot,
		mentionListOpenRef,
		registerSubmitHandler,
	};

	return (
		<PromptEditorContext.Provider value={value}>
			<div ref={hiddenSlotRef} className="prompt-editor-hidden-slot" aria-hidden />
			<div ref={editorWrapRef} className="prompt-editor-wrap">
				{editor ? <EditorContent editor={editor} /> : null}
			</div>
			{children}
		</PromptEditorContext.Provider>
	);
}

export { filesFromEntries };

interface PromptEditorSlotProps {
	slotId: PromptEditorSlotId;
	className?: string;
}

/** 空挂载槽：React 不渲染 children，由 Portal 托管 editor DOM */
export function PromptEditorSlot({ slotId, className }: PromptEditorSlotProps) {
	const { registerSlot } = usePromptEditor();
	const ref = useCallback(
		(el: HTMLDivElement | null) => {
			registerSlot(slotId, el);
		},
		[registerSlot, slotId],
	);

	return <div ref={ref} className={className ?? "prompt-editor-slot"} />;
}

export type { SelectedFileEntry };

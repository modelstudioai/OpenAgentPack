import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import MentionList, { type MentionListRef } from "@/components/prompt-editor/MentionList";
import { listFiles, stripPrefix, type UploadedFile } from "@/lib/domain/file-api";
import { filesFromEntries, type SelectedFileEntry } from "@/lib/hooks/selected-files";

export interface FileMentionOptions {
	getSelectedEntries: () => SelectedFileEntry[];
	onMentionSelect: (file: UploadedFile) => void;
	setMentionListOpen?: (open: boolean) => void;
}

async function fetchMentionItems(query: string, selectedEntries: SelectedFileEntry[]): Promise<UploadedFile[]> {
	const selectedFiles = filesFromEntries(selectedEntries);
	const q = query.trim().toLowerCase();

	let library: UploadedFile[] = [];
	try {
		library = await listFiles();
	} catch {
		library = [];
	}

	const available = library.filter((f) => f.available);
	const seen = new Set<string>();
	const merged: UploadedFile[] = [];

	for (const f of selectedFiles) {
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		merged.push(f);
	}
	for (const f of available) {
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		merged.push(f);
	}

	if (!q) return merged.slice(0, 20);
	return merged.filter((f) => stripPrefix(f.filename).toLowerCase().includes(q)).slice(0, 20);
}

export function createFileMentionExtension(options: FileMentionOptions) {
	return Mention.configure({
		HTMLAttributes: {
			class: "mention-tag",
		},
		deleteTriggerWithBackspace: true,
		renderText({ node }) {
			return `@${node.attrs.label ?? ""}`;
		},
		suggestion: {
			char: "@",
			allowSpaces: false,
			items: async ({ query }) => fetchMentionItems(query, options.getSelectedEntries()),
			render: () => {
				let component: ReactRenderer<MentionListRef> | null = null;

				const positionPopup = (props: { clientRect?: (() => DOMRect | null) | null }) => {
					if (!component) return;
					const rect = props.clientRect?.();
					if (!rect) return;
					const el = component.element as HTMLElement;
					el.style.position = "fixed";
					el.style.left = `${rect.left}px`;
					el.style.top = `${rect.bottom + 4}px`;
					el.style.zIndex = "10000";
				};

				return {
					onStart: (props) => {
						options.setMentionListOpen?.(true);
						component = new ReactRenderer(MentionList, {
							props: {
								items: props.items as UploadedFile[],
								command: (item: { id: string; label: string }) => {
									const file =
										(props.items as UploadedFile[]).find((f) => f.id === item.id) ??
										options.getSelectedEntries().find((e) => e.file.id === item.id)?.file;
									if (file) options.onMentionSelect(file);
									props.command({ id: item.id, label: item.label });
								},
							},
							editor: props.editor,
						});
						document.body.appendChild(component.element);
						component.element.classList.add("mention-suggest-portal");
						positionPopup(props);
					},
					onUpdate(props) {
						component?.updateProps({
							items: props.items as UploadedFile[],
							command: (item: { id: string; label: string }) => {
								const file =
									(props.items as UploadedFile[]).find((f) => f.id === item.id) ??
									options.getSelectedEntries().find((e) => e.file.id === item.id)?.file;
								if (file) options.onMentionSelect(file);
								props.command({ id: item.id, label: item.label });
							},
						});
						positionPopup(props);
					},
					onKeyDown(props) {
						if (props.event.key === "Escape") {
							component?.destroy();
							component = null;
							return true;
						}
						return component?.ref?.onKeyDown(props) ?? false;
					},
					onExit() {
						options.setMentionListOpen?.(false);
						component?.destroy();
						component = null;
					},
				};
			},
		} satisfies Omit<SuggestionOptions, "editor">,
	});
}

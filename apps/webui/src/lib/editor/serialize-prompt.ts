import type { Editor } from "@tiptap/core";
import { filesFromEntries, type SelectedFileEntry } from "@/lib/hooks/selected-files";
import { buildFileBindings } from "@/lib/hooks/useFileUploads";

/** 内部占位符：提交后由 SDK 按 provider 替换为真实 sandbox 路径 */
export const FILE_MENTION_SENTINEL_OPEN = "\u27E6file:";
export const FILE_MENTION_SENTINEL_CLOSE = "\u27E7";

export function fileMentionSentinel(mountPath: string): string {
	return `${FILE_MENTION_SENTINEL_OPEN}${mountPath}${FILE_MENTION_SENTINEL_CLOSE}`;
}

/**
 * 将 Editor 文档序列化为提交用 plain text。
 * mention node 按 fileId 查 buildFileBindings 映射；查不到则回退 @label。
 */
export function editorToSubmitPrompt(editor: Editor, selectedFiles: SelectedFileEntry[]): string {
	const files = filesFromEntries(selectedFiles);
	const mountByFileId = new Map(buildFileBindings(files).map((b) => [b.fileId, b.mountPath]));

	const parts: string[] = [];

	editor.state.doc.descendants((node) => {
		if (node.isText) {
			parts.push(node.text ?? "");
			return;
		}
		if (node.type.name === "mention") {
			const fileId = node.attrs.id as string | undefined;
			const label = (node.attrs.label as string | undefined) ?? "";
			const mountPath = fileId ? mountByFileId.get(fileId) : undefined;
			if (mountPath) {
				parts.push(fileMentionSentinel(mountPath));
			} else {
				parts.push(`@${label}`);
			}
		}
	});

	return parts.join("").trim();
}

/** Editor 当前内容的 plain 文本镜像（供 inputValue / ghost 显隐） */
export function editorToPlainMirror(editor: Editor): string {
	const parts: string[] = [];
	editor.state.doc.descendants((node) => {
		if (node.isText) {
			parts.push(node.text ?? "");
			return;
		}
		if (node.type.name === "mention") {
			const label = (node.attrs.label as string | undefined) ?? "";
			parts.push(`@${label}`);
		}
	});
	return parts.join("");
}

/** 收集文档内 mention 的 fileId 集合 */
export function collectMentionFileIds(editor: Editor): Set<string> {
	const ids = new Set<string>();
	editor.state.doc.descendants((node) => {
		if (node.type.name === "mention" && node.attrs.id) {
			ids.add(node.attrs.id as string);
		}
	});
	return ids;
}

/** 外部写入：纯文本 doc JSON，不解析 @ 为 mention */
export function plainTextToDocJson(text: string): {
	type: "doc";
	content: { type: "paragraph"; content?: { type: "text"; text: string }[] }[];
} {
	if (!text) {
		return { type: "doc", content: [{ type: "paragraph" }] };
	}
	const lines = text.split("\n");
	return {
		type: "doc",
		content: lines.map((line) => ({
			type: "paragraph" as const,
			content: line ? [{ type: "text" as const, text: line }] : undefined,
		})),
	};
}

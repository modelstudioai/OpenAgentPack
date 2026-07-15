import { stripPrefix } from "@/lib/domain/file-api";
import { parseFileMountHint } from "@/lib/file-mount-hint";

export type FileMentionSegment = { kind: "text"; value: string } | { kind: "mention"; path: string; label: string };

/** 与 serialize-prompt / SDK rewriteFileMentions 一致的占位符匹配 */
function createFileMentionPattern(): RegExp {
	return /\u27E6file:(.+?)\u27E7/g;
}

function labelFromMountPath(mountPath: string): string {
	const trimmed = mountPath.trim().replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	const basename = idx === -1 ? trimmed : trimmed.slice(idx + 1);
	return stripPrefix(basename);
}

/** 将文本按 ⟦file:mountPath⟧ 切分为 plain / mention 片段（仅展示用） */
export function splitFileMentionSentinels(text: string): FileMentionSegment[] {
	const segments: FileMentionSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(createFileMentionPattern())) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			segments.push({ kind: "text", value: text.slice(lastIndex, index) });
		}
		const path = (match[1] ?? "").trim();
		if (path) {
			segments.push({ kind: "mention", path, label: labelFromMountPath(path) });
		}
		lastIndex = index + match[0].length;
	}

	if (lastIndex < text.length) {
		segments.push({ kind: "text", value: text.slice(lastIndex) });
	}

	return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}

export function hasFileMentionSentinels(text: string): boolean {
	// 不用 g 标志，避免污染 lastIndex
	return /\u27E6file:(.+?)\u27E7/.test(text);
}

/** 展示用正文：剥离 SDK 注入的 file-mount hint */
export function userMessageBodyForDisplay(text: string): string {
	return parseFileMountHint(text)?.prompt ?? text;
}

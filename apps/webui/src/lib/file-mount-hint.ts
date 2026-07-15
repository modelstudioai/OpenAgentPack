// 与 packages/sdk/src/internal/utils/sandbox-mount.ts 的 compose 格式一致，用于从用户消息中解析附件。

const FILE_MOUNT_HINT_LEAD = "The user uploaded files. They are available at the following sandbox paths:";
const FILE_MOUNT_HINT_TAIL = "Read them from these paths when relevant.";

function sandboxPathBasename(path: string): string {
	const trimmed = path.trim().replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** 拼接 file-mount hint 正文（不含用户 prompt） */
export function composeFileMountHintBody(pathLines: string[]): string {
	return [FILE_MOUNT_HINT_LEAD, ...pathLines, FILE_MOUNT_HINT_TAIL].join("\n");
}

/** 从带 file-mount hint 的用户消息中解析附件名与真实 prompt */
export function parseFileMountHint(text: string): { files: string[]; prompt: string } | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(FILE_MOUNT_HINT_LEAD)) return null;

	const rest = trimmed.slice(FILE_MOUNT_HINT_LEAD.length).trimStart();
	const tailIndex = rest.indexOf(FILE_MOUNT_HINT_TAIL);
	if (tailIndex === -1) return null;

	const pathsBlock = rest.slice(0, tailIndex).trim();
	const prompt = rest.slice(tailIndex + FILE_MOUNT_HINT_TAIL.length).replace(/^\n+/, "");

	const files = pathsBlock
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => sandboxPathBasename(line.slice(2)));

	return { files, prompt };
}

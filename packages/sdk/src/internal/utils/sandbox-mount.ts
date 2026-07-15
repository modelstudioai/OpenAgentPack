// Single source of truth for where an uploaded file actually lands inside the agent sandbox.
//
// The mount_path the SDK *sends* is not the path the model *sees*: Agents backends (bailian,
// claude) prepend `/mnt/session` to it, while qoder mounts uploads under `/data/`. We resolve
// the real sandbox path here so both the wire mapper and the prompt hint stay in lockstep —
// the model is told the same path the file is actually written to.
//
// Pure string ops only (no `node:path`): this module ships to the browser via the SDK bundle.

const AGENTS_SESSION_PREFIX = "/mnt/session";

function joinAbsolute(prefix: string, sub: string): string {
	const left = prefix.replace(/\/+$/, "");
	const right = sub.replace(/^\/+/, "");
	return `${left}/${right}`;
}

function basename(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Map the SDK-sent `mount_path` to the absolute path the file occupies inside the sandbox.
 * - ark / bailian / claude: backend self-prefixes `/mnt/session`, preserving subdirs.
 * - qoder: uploads live under `/data/<basename>` (qoder's mount root; subdirs are flattened).
 * - unknown provider: return the path unchanged (conservative).
 */
export function resolveSandboxMountPath(provider: string, mountPath: string): string {
	switch (provider) {
		case "ark":
		case "bailian":
		case "claude":
			return joinAbsolute(AGENTS_SESSION_PREFIX, mountPath);
		case "qoder":
			return joinAbsolute("/data", basename(mountPath));
		default:
			return mountPath;
	}
}

/** Files as carried by `SessionBindings.files` — only `mount_path` matters for the hint. */
export interface MountedFile {
	mount_path: string;
}

/**
 * Build an English hint listing the real sandbox paths of the uploaded files, so the model
 * knows where to read them. Returns "" when there are no files.
 */
export function composeFileMountHint(files: MountedFile[] | undefined, provider: string): string {
	if (!files || files.length === 0) return "";
	const lines = files.map((f) => `- ${resolveSandboxMountPath(provider, f.mount_path)}`);
	return [
		"The user uploaded files. They are available at the following sandbox paths:",
		...lines,
		"Read them from these paths when relevant.",
	].join("\n");
}

/** Prepend the file-mount hint to a prompt. Returns the prompt unchanged when there are no files. */
export function prependFileHint(prompt: string, files: MountedFile[] | undefined, provider: string): string {
	const hint = composeFileMountHint(files, provider);
	if (!hint) return prompt;
	return `${hint}\n\n${prompt}`;
}

const FILE_MENTION_SENTINEL_RE = /\u27E6file:(.+?)\u27E7/g;

/** 将 prompt 内 ⟦file:mountPath⟧ 占位符替换为 provider 感知的真实 sandbox 路径 */
export function rewriteFileMentions(prompt: string, provider: string): string {
	return prompt.replace(FILE_MENTION_SENTINEL_RE, (_match, mountPath: string) =>
		resolveSandboxMountPath(provider, mountPath),
	);
}

/** 发送给 provider 前统一处理：先替换 mention 占位符，再 prepend 文件 hint */
export function preparePromptForProvider(prompt: string, files: MountedFile[] | undefined, provider: string): string {
	return prependFileHint(rewriteFileMentions(prompt, provider), files, provider);
}

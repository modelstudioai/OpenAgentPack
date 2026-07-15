import { stripPrefix, type UploadedFile } from "@/lib/domain/file-api";

/**
 * Single source of truth for the file picker's `accept` filter. Images are kept (some are rendered
 * as previews elsewhere); the rest are text/code/document/archive types.
 */
export const ACCEPTED_FILE_TYPES =
	"image/*,.txt,.md,.json,.yaml,.yml,.js,.ts,.py,.go,.html,.css,.sql,.xml,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp3,.mp4,.wav,.ogg,.webm,.mov";

export interface SessionFileBinding {
	fileId: string;
	mountPath: string;
}

/**
 * Build the `{ fileId, mountPath }[]` session-resource bindings from the files chosen in the picker.
 * Selected files are always `available` (the picker only lets you select available rows), so they
 * bind without further checks. mount_path is required by the provider; we mount each file at
 * `/uploads/<name>` (prefix stripped so the sandbox sees the clean original name). Same-name files
 * would collide on one path, so duplicates are disambiguated with a `-N` suffix before the extension.
 */
export function buildFileBindings(files: UploadedFile[]): SessionFileBinding[] {
	const seen = new Map<string, number>();
	const bindings: SessionFileBinding[] = [];
	for (const f of files) {
		const name = stripPrefix(f.filename);
		const dot = name.lastIndexOf(".");
		const base = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		const count = seen.get(name) ?? 0;
		seen.set(name, count + 1);
		const mountName = count === 0 ? name : `${base}-${count}${ext}`;
		bindings.push({ fileId: f.id, mountPath: `/uploads/${mountName}` });
	}
	return bindings;
}

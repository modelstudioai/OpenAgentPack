import type { UploadedFile } from "@/lib/domain/file-api";

/** 附件进入 selectedFiles 的途径 */
export type SelectedFileSource = "picker" | "mention";

export interface SelectedFileEntry {
	file: UploadedFile;
	sources: Set<SelectedFileSource>;
}

export function createSelectedEntry(file: UploadedFile, source: SelectedFileSource): SelectedFileEntry {
	return { file, sources: new Set([source]) };
}

export function filesFromEntries(entries: SelectedFileEntry[]): UploadedFile[] {
	return entries.map((e) => e.file);
}

export function entryIds(entries: SelectedFileEntry[]): string[] {
	return entries.map((e) => e.file.id);
}

export function findEntry(entries: SelectedFileEntry[], fileId: string): SelectedFileEntry | undefined {
	return entries.find((e) => e.file.id === fileId);
}

/** 通过 + 或 @ 加入附件（去重合并 sources） */
export function addSource(
	entries: SelectedFileEntry[],
	file: UploadedFile,
	source: SelectedFileSource,
): SelectedFileEntry[] {
	const existing = findEntry(entries, file.id);
	if (existing) {
		const nextSources = new Set(existing.sources);
		nextSources.add(source);
		return entries.map((e) => (e.file.id === file.id ? { ...e, sources: nextSources } : e));
	}
	return [...entries, createSelectedEntry(file, source)];
}

/** chip × 移除：清空全部 sources */
export function removeEntry(entries: SelectedFileEntry[], fileId: string): SelectedFileEntry[] {
	return entries.filter((e) => e.file.id !== fileId);
}

/** 去掉某一来源；sources 为空则移除条目 */
export function removeSource(
	entries: SelectedFileEntry[],
	fileId: string,
	source: SelectedFileSource,
): SelectedFileEntry[] {
	return entries
		.map((e) => {
			if (e.file.id !== fileId) return e;
			const next = new Set(e.sources);
			next.delete(source);
			if (next.size === 0) return null;
			return { ...e, sources: next };
		})
		.filter((e): e is SelectedFileEntry => e !== null);
}

/**
 * FilePicker confirm 合并：返回集 → 加/保留 picker 来源；未返回但仍带 mention 来源 → 保留并去掉 picker；
 * 两种来源都没有 → 移除。
 */
export function mergePickerConfirm(entries: SelectedFileEntry[], confirmed: UploadedFile[]): SelectedFileEntry[] {
	const confirmedIds = new Set(confirmed.map((f) => f.id));
	const next: SelectedFileEntry[] = [];

	for (const entry of entries) {
		const inPicker = confirmedIds.has(entry.file.id);
		const sources = new Set(entry.sources);
		if (inPicker) sources.add("picker");
		else sources.delete("picker");
		if (sources.size === 0) continue;
		next.push({ file: entry.file, sources });
	}

	for (const file of confirmed) {
		if (findEntry(next, file.id)) continue;
		next.push(createSelectedEntry(file, "picker"));
	}

	return next;
}

/** 根据文档内 mention fileId 集合，同步各条目的 mention 来源 */
export function reconcileMentionSources(
	entries: SelectedFileEntry[],
	mentionFileIds: Set<string>,
): SelectedFileEntry[] {
	return entries
		.map((e) => {
			const sources = new Set(e.sources);
			if (mentionFileIds.has(e.file.id)) {
				sources.add("mention");
			} else {
				sources.delete("mention");
			}
			if (sources.size === 0) return null;
			return { file: e.file, sources };
		})
		.filter((e): e is SelectedFileEntry => e !== null);
}

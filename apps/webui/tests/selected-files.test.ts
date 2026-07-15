import { describe, expect, test } from "bun:test";
import type { UploadedFile } from "@/lib/domain/file-api";
import { createSelectedEntry, mergePickerConfirm, reconcileMentionSources } from "@/lib/hooks/selected-files";

const fileA: UploadedFile = { id: "a", filename: "a.png", mime_type: "image/png", size_bytes: 1 };
const fileB: UploadedFile = { id: "b", filename: "b.png", mime_type: "image/png", size_bytes: 1 };

describe("mergePickerConfirm", () => {
	test("keeps mention-only file when deselected in picker", () => {
		const entries = [createSelectedEntry(fileA, "mention")];
		const next = mergePickerConfirm(entries, []);
		expect(next).toHaveLength(1);
		expect(next[0]?.file.id).toBe("a");
		expect(next[0]?.sources.has("mention")).toBe(true);
		expect(next[0]?.sources.has("picker")).toBe(false);
	});

	test("adds picker source on confirm", () => {
		const entries = [createSelectedEntry(fileA, "mention")];
		const next = mergePickerConfirm(entries, [fileA, fileB]);
		expect(next.find((e) => e.file.id === "a")?.sources.has("picker")).toBe(true);
		expect(next.find((e) => e.file.id === "b")?.sources.has("picker")).toBe(true);
	});
});

describe("reconcileMentionSources", () => {
	test("removes mention-only entry when mention gone", () => {
		const entries = [createSelectedEntry(fileA, "mention")];
		const next = reconcileMentionSources(entries, new Set());
		expect(next).toHaveLength(0);
	});

	test("keeps picker entry when mention removed", () => {
		const entry = createSelectedEntry(fileA, "picker");
		entry.sources.add("mention");
		const next = reconcileMentionSources([entry], new Set());
		expect(next).toHaveLength(1);
		expect(next[0]?.sources.has("picker")).toBe(true);
		expect(next[0]?.sources.has("mention")).toBe(false);
	});
});

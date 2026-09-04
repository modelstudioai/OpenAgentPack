import { describe, expect, test } from "bun:test";
import Document from "@tiptap/extension-document";
import Mention from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Fragment } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Editor } from "@tiptap/react";
import { editorToSubmitPrompt, fileMentionSentinel } from "@/lib/editor/serialize-prompt";
import { createSelectedEntry } from "@/lib/hooks/selected-files";

function makeEditor(content: object) {
	return new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			Mention.configure({
				HTMLAttributes: { class: "mention-tag" },
			}),
		],
		content,
	});
}

describe("editorToSubmitPrompt", () => {
	test("splits paragraphs using a single ProseMirror model instance", () => {
		const editor = makeEditor({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "abcd" }] }],
		});
		try {
			expect(ReplaceStep.fromJSON(editor.schema, { from: 0, to: 0 }).slice.content).toBeInstanceOf(Fragment);
			editor.commands.setTextSelection(3);
			expect(editor.commands.splitBlock()).toBe(true);
			expect(editor.getJSON().content).toEqual([
				{ type: "paragraph", content: [{ type: "text", text: "ab" }] },
				{ type: "paragraph", content: [{ type: "text", text: "cd" }] },
			]);
		} finally {
			editor.destroy();
		}
	});

	test("mention maps to sentinel via buildFileBindings", () => {
		const editor = makeEditor({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "参考 " },
						{ type: "mention", attrs: { id: "file_a", label: "a.png" } },
						{ type: "text", text: " 背景" },
					],
				},
			],
		});
		const selected = [
			createSelectedEntry({ id: "file_a", filename: "a.png", mime_type: "image/png", size_bytes: 1 }, "mention"),
		];
		const out = editorToSubmitPrompt(editor, selected);
		expect(out).toContain(fileMentionSentinel("/uploads/a.png"));
		expect(out).not.toContain("@a.png");
		editor.destroy();
	});

	test("unknown fileId falls back to @label", () => {
		const editor = makeEditor({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "mention", attrs: { id: "missing", label: "x.png" } }],
				},
			],
		});
		const out = editorToSubmitPrompt(editor, []);
		expect(out).toBe("@x.png");
		editor.destroy();
	});
});

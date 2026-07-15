import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const mentionDeleteKey = new PluginKey("mentionDelete");

function isMentionNode(name: string | undefined): boolean {
	return name === "mention";
}

/** Backspace/Delete 在 atom mention 边界整颗删除；IME 组合态不拦截 */
export const MentionDeleteExtension = Extension.create({
	name: "mentionDelete",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: mentionDeleteKey,
				props: {
					handleKeyDown(view, event) {
						if (event.isComposing) return false;
						if (event.key !== "Backspace" && event.key !== "Delete") return false;

						const { state } = view;
						const { selection } = state;
						if (!selection.empty) return false;

						const { $from } = selection;
						const isBackspace = event.key === "Backspace";

						if (isBackspace) {
							const nodeBefore = $from.nodeBefore;
							if (nodeBefore && isMentionNode(nodeBefore.type.name)) {
								const from = $from.pos - nodeBefore.nodeSize;
								const tr = state.tr.delete(from, $from.pos);
								view.dispatch(tr);
								event.preventDefault();
								return true;
							}
						} else {
							const nodeAfter = $from.nodeAfter;
							if (nodeAfter && isMentionNode(nodeAfter.type.name)) {
								const to = $from.pos + nodeAfter.nodeSize;
								const tr = state.tr.delete($from.pos, to);
								view.dispatch(tr);
								event.preventDefault();
								return true;
							}
						}

						return false;
					},
				},
			}),
		];
	},
});

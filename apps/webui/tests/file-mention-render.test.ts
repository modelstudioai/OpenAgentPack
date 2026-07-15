import { expect, test } from "bun:test";
import { fileMentionSentinel } from "@/lib/editor/serialize-prompt";
import { composeFileMountHintBody } from "@/lib/file-mount-hint";
import {
	hasFileMentionSentinels,
	splitFileMentionSentinels,
	userMessageBodyForDisplay,
} from "@/lib/view/file-mention-render";

test("splitFileMentionSentinels 解析多个占位符", () => {
	const s1 = fileMentionSentinel("/uploads/testimonial.png");
	const s2 = fileMentionSentinel("/uploads/story.png");
	const text = `将 ${s1} 和 ${s2} 合成一张图片`;
	const segments = splitFileMentionSentinels(text);
	const mentions = segments.filter((s) => s.kind === "mention");
	expect(mentions).toHaveLength(2);
	expect(mentions[0]).toMatchObject({ path: "/uploads/testimonial.png", label: "testimonial.png" });
	expect(mentions[1]).toMatchObject({ path: "/uploads/story.png", label: "story.png" });
});

test("hasFileMentionSentinels 后 split 仍匹配全部", () => {
	const s1 = fileMentionSentinel("/uploads/a.png");
	const s2 = fileMentionSentinel("/uploads/b.png");
	const text = `${s1} ${s2}`;
	expect(hasFileMentionSentinels(text)).toBe(true);
	expect(splitFileMentionSentinels(text).filter((s) => s.kind === "mention")).toHaveLength(2);
});

test("userMessageBodyForDisplay 剥离 file-mount hint", () => {
	const hint = composeFileMountHintBody(["- /mnt/session/uploads/x.png"]);
	const body = `${fileMentionSentinel("/uploads/x.png")} 说明`;
	expect(userMessageBodyForDisplay(`${hint}\n\n${body}`)).toBe(body);
});

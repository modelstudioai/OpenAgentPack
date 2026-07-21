import { describe, expect, test } from "bun:test";
import {
	composeFileMountHint,
	preparePromptForProvider,
	prependFileHint,
	resolveSandboxMountPath,
	rewriteFileMentions,
} from "../../src/internal/utils/sandbox-mount.ts";

describe("resolveSandboxMountPath", () => {
	test("uses each provider's fixed mount prefix and preserves subdirs", () => {
		expect(resolveSandboxMountPath("qoder", "uploads/report.pdf")).toBe("/data/uploads/report.pdf");
		expect(resolveSandboxMountPath("claude", "uploads/a/b.txt")).toBe("/workspace/uploads/a/b.txt");
		expect(resolveSandboxMountPath("bailian", "uploads/report.pdf")).toBe("/mnt/uploads/report.pdf");
		expect(resolveSandboxMountPath("ark", "uploads/report.pdf")).toBe("/mnt/uploads/report.pdf");
	});

	test("collapses duplicate slashes at the join", () => {
		expect(resolveSandboxMountPath("bailian", "uploads/x.txt")).toBe("/mnt/uploads/x.txt");
		expect(resolveSandboxMountPath("claude", "uploads//x.txt")).toBe("/workspace/uploads//x.txt");
	});

	test("rejects an absolute path under the wrong provider root", () => {
		expect(() => resolveSandboxMountPath("qoder", "/workspace/report.pdf")).toThrow(
			"qoder mount_path must start with '/data/'",
		);
		expect(() => resolveSandboxMountPath("claude", "/mnt/report.pdf")).toThrow(
			"claude mount_path must start with '/workspace/'",
		);
	});

	test("does not duplicate a correct prefix", () => {
		expect(resolveSandboxMountPath("qoder", "/data/report.pdf")).toBe("/data/report.pdf");
		expect(resolveSandboxMountPath("claude", "/workspace/nested/x.txt")).toBe("/workspace/nested/x.txt");
		expect(resolveSandboxMountPath("qoder", "report.pdf")).toBe("/data/report.pdf");
	});

	test("unknown provider returns the path unchanged", () => {
		expect(resolveSandboxMountPath("mystery", "/uploads/x.txt")).toBe("/uploads/x.txt");
	});
});

describe("composeFileMountHint", () => {
	test("no files → empty string", () => {
		expect(composeFileMountHint(undefined, "bailian")).toBe("");
		expect(composeFileMountHint([], "qoder")).toBe("");
	});

	test("lists resolved sandbox paths per provider", () => {
		const hint = composeFileMountHint([{ mount_path: "uploads/a.txt" }], "bailian");
		expect(hint).toContain("- /mnt/uploads/a.txt");
		expect(hint).toContain("The user uploaded files");
	});

	test("multiple files each get a line", () => {
		const hint = composeFileMountHint([{ mount_path: "uploads/a.txt" }, { mount_path: "uploads/b.txt" }], "qoder");
		expect(hint).toContain("- /data/uploads/a.txt");
		expect(hint).toContain("- /data/uploads/b.txt");
	});
});

describe("prependFileHint", () => {
	test("no files → prompt unchanged", () => {
		expect(prependFileHint("hello", undefined, "bailian")).toBe("hello");
		expect(prependFileHint("hello", [], "qoder")).toBe("hello");
	});

	test("hint comes before the original prompt", () => {
		const out = prependFileHint("summarize it", [{ mount_path: "uploads/a.txt" }], "bailian");
		expect(out.endsWith("\n\nsummarize it")).toBe(true);
		expect(out.indexOf("/mnt/uploads/a.txt")).toBeLessThan(out.indexOf("summarize it"));
	});
});

describe("rewriteFileMentions", () => {
	test("replaces sentinel with sandbox path", () => {
		const prompt = `see ${"\u27E6file:uploads/a.png\u27E7"} here`;
		expect(rewriteFileMentions(prompt, "bailian")).toBe("see /mnt/uploads/a.png here");
	});

	test("no sentinel → unchanged", () => {
		expect(rewriteFileMentions("hello", "bailian")).toBe("hello");
	});
});

describe("preparePromptForProvider", () => {
	test("rewrites sentinel then prepends hint", () => {
		const prompt = `use ${"\u27E6file:uploads/a.txt\u27E7"}`;
		const out = preparePromptForProvider(prompt, [{ mount_path: "uploads/a.txt" }], "bailian");
		expect(out).toContain("/mnt/uploads/a.txt");
		expect(out).toContain("The user uploaded files");
	});
});

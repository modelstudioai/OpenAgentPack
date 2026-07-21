import { describe, expect, test } from "bun:test";
import type { SessionBindings } from "../../src/internal/types/session.ts";
import {
	composeFileMountHint,
	prepareInitialSessionPrompt,
	preparePromptForProvider,
	prependFileHint,
	resolveSandboxMountPath,
	rewriteFileMentions,
} from "../../src/internal/utils/sandbox-mount.ts";

function bindings(resources: SessionBindings["resources"] = []): SessionBindings {
	return {
		agent_id: "agent_1",
		environment_id: "env_1",
		vault_ids: [],
		memory_store_ids: [],
		resources,
	};
}

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

describe("prepareInitialSessionPrompt", () => {
	test("uses a single Git repository as the task working directory", () => {
		const out = prepareInitialSessionPrompt(
			"implement the feature",
			bindings([
				{
					type: "github_repository",
					url: "https://gitlab.example.com/team/repo.git",
					authorization_token: "do-not-leak",
				},
			]),
			"qoder",
		);
		expect(out).toContain("The Git working tree for this task is mounted at `/data/workspace/repo`.");
		expect(out).toContain("Prefix every shell command with:\ncd -- '/data/workspace/repo' &&");
		expect(out).toContain("Use absolute paths under `/data/workspace/repo` for non-shell file tools.");
		expect(out).not.toContain("gitlab.example.com");
		expect(out).not.toContain("do-not-leak");
		expect(out.endsWith("implement the feature")).toBe(true);
	});

	test("shell-quotes an explicit repository mount path", () => {
		const out = prepareInitialSessionPrompt(
			"inspect it",
			bindings([
				{
					type: "github_repository",
					url: "https://code.example.com/team/repo.git",
					authorization_token: "secret",
					mount_path: "/data/workspace/team's repo",
				},
			]),
			"qoder",
		);
		expect(out).toContain(`cd -- '/data/workspace/team'"'"'s repo' &&`);
	});

	test("supports scp-like Git remotes without naming a single working directory when several are mounted", () => {
		const out = prepareInitialSessionPrompt(
			"coordinate the change",
			bindings([
				{
					type: "github_repository",
					url: "git@host.example.com:team/api.git",
					authorization_token: "secret-a",
				},
				{
					type: "github_repository",
					url: "https://gitea.example.com/team/web.git",
					authorization_token: "secret-b",
					mount_path: "/data/projects/web",
				},
			]),
			"qoder",
		);
		expect(out).toContain("- /data/workspace/api");
		expect(out).toContain("- /data/projects/web");
		expect(out).toContain("Choose the appropriate working tree");
		expect(out).not.toContain(" as the working directory");
	});

	test("leaves prompts unchanged when the Session has no files or repositories", () => {
		expect(prepareInitialSessionPrompt("hello", bindings(), "qoder")).toBe("hello");
	});
});

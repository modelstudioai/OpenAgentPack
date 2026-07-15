import { afterEach, describe, expect, mock, test } from "bun:test";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import type { SkillFile } from "../../src/internal/types/skill-file.ts";

// The Claude Skills API rejects an upload (HTTP 400) unless every file sits under a single
// top-level directory whose name matches the `name:` field in SKILL.md. These tests lock in
// that the uploaded folder is derived from SKILL.md (not a hardcoded "skill" prefix), with a
// fallback to the agents resource name when SKILL.md carries no name.

function mockFetch(body: unknown) {
	const bodies: FormData[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock(async (_input: string | URL, init?: RequestInit) => {
		bodies.push(init?.body as FormData);
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return {
		bodies,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

function folderNames(form: FormData): string[] {
	return (form.getAll("files[]") as File[]).map((f) => f.name.split("/")[0]);
}

const skillMd = (name: string): SkillFile => ({
	relativePath: "SKILL.md",
	content: Buffer.from(`---\nname: ${name}\ndescription: x\n---\n# body\n`),
});

describe("ClaudeAdapter skill upload folder name", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("derives the folder from SKILL.md name, ignoring the resource name", async () => {
		const { bodies, restore } = mockFetch({ id: "skill_1", type: "skill" });
		cleanup = restore;
		const files: SkillFile[] = [skillMd("code-review"), { relativePath: "ref.md", content: Buffer.from("ref") }];

		await new ClaudeAdapter("sk-ant-test", undefined, "test-project").createSkill("agents-key", { source: "x" }, files);

		expect(folderNames(bodies[0])).toEqual(["code-review", "code-review"]);
	});

	test("falls back to the resource name when SKILL.md has no name", async () => {
		const { bodies, restore } = mockFetch({ id: "skill_1", type: "skill" });
		cleanup = restore;
		const files: SkillFile[] = [{ relativePath: "SKILL.md", content: Buffer.from("# no frontmatter") }];

		await new ClaudeAdapter("sk-ant-test", undefined, "test-project").createSkill(
			"fallback-name",
			{ source: "x" },
			files,
		);

		expect(folderNames(bodies[0])).toEqual(["fallback-name"]);
	});
});

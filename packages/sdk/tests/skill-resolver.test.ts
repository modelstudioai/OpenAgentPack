import { afterEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import type { ExecContext } from "../src/internal/executor/context.ts";
import { resolveSkillFiles } from "../src/internal/executor/skill-resolver.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function makeSkillZip(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("SKILL.md", "# demo skill");
	return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

describe("resolveSkillFiles — remote source", () => {
	test("fetches an http(s) source and extracts its zip entries", async () => {
		const url = "https://freyr.oss-cn-beijing.aliyuncs.com/app-studio/skills/test-skill.zip";
		const zip = await makeSkillZip();
		let requested = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested = String(input);
			return new Response(zip, { status: 200 });
		}) as typeof fetch;

		// configPath is unused on the remote branch — a bare ctx suffices.
		const files = await resolveSkillFiles({ source: url }, {} as ExecContext);

		expect(requested).toBe(url);
		expect(files.map((f) => f.relativePath)).toContain("SKILL.md");
	});

	test("throws on a non-ok remote response", async () => {
		globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
		await expect(resolveSkillFiles({ source: "https://example.com/missing.zip" }, {} as ExecContext)).rejects.toThrow(
			/下载失败/,
		);
	});
});

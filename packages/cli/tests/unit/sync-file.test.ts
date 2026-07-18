import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "@openagentpack/sdk";
import { removeMissingFileAssociations, syncCommand } from "../../src/commands/sync.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agents-sync-file-"));
	tempDirs.push(dir);
	return dir;
}

test("syncCommand requires --provider when config file is missing", async () => {
	const dir = await makeTempDir();
	const missingConfig = join(dir, "missing.yaml");
	const outPath = join(dir, "out.yaml");

	await expect(syncCommand({ file: missingConfig, out: outPath })).rejects.toThrow(UserError);
	await expect(syncCommand({ file: missingConfig, out: outPath })).rejects.toThrow(
		"--provider when no config file exists",
	);
});

test("removeMissingFileAssociations keeps existing sources and skips missing files", async () => {
	const dir = await makeTempDir();
	await Bun.write(join(dir, "present.txt"), "present\n");

	const config = {
		files: {
			present: { source: "present.txt" },
			missing: { source: "missing.txt" },
		},
	};

	expect(removeMissingFileAssociations(config, dir)).toEqual(["missing"]);
});

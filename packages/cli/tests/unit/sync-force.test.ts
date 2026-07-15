import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "@openagentpack/sdk";
import { ensureSyncOutputWritable } from "../../src/commands/sync.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

test("ensureSyncOutputWritable allows writing when output file is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "agents-sync-force-"));
	tempDirs.push(dir);
	const outPath = join(dir, "agents.synced.yaml");

	expect(() => ensureSyncOutputWritable(outPath)).not.toThrow();
});

test("ensureSyncOutputWritable rejects existing output without --force", async () => {
	const dir = await mkdtemp(join(tmpdir(), "agents-sync-force-"));
	tempDirs.push(dir);
	const outPath = join(dir, "agents.synced.yaml");
	await writeFile(outPath, 'version: "1"\n', "utf8");

	expect(() => ensureSyncOutputWritable(outPath)).toThrow(UserError);
	expect(() => ensureSyncOutputWritable(outPath)).toThrow("already exists");
	expect(() => ensureSyncOutputWritable(outPath)).toThrow("--force");
});

test("ensureSyncOutputWritable allows overwrite when --force is set", async () => {
	const dir = await mkdtemp(join(tmpdir(), "agents-sync-force-"));
	tempDirs.push(dir);
	const outPath = join(dir, "agents.synced.yaml");
	await writeFile(outPath, 'version: "1"\n', "utf8");

	expect(() => ensureSyncOutputWritable(outPath, true)).not.toThrow();
});

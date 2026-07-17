import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const webuiDir = resolve(import.meta.dir, "..");
let generatedDir: string | undefined;

afterAll(async () => {
	if (generatedDir) await rm(generatedDir, { recursive: true, force: true });
});

describe("generated HTTP wire contract", () => {
	test("matches the committed OpenAPI snapshot", async () => {
		generatedDir = await mkdtemp(join(tmpdir(), "openagentpack-api-types-"));
		const generatedPath = join(generatedDir, "schema.d.ts");
		const process = Bun.spawn(
			[resolve(webuiDir, "node_modules/.bin/openapi-typescript"), "../server/openapi.json", "-o", generatedPath],
			{
				cwd: webuiDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const exitCode = await process.exited;
		if (exitCode !== 0) {
			throw new Error(await new Response(process.stderr).text());
		}
		const formatProcess = Bun.spawn(
			[resolve(webuiDir, "../../node_modules/.bin/biome"), "format", "--write", generatedPath],
			{
				cwd: webuiDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const formatExitCode = await formatProcess.exited;
		if (formatExitCode !== 0) {
			throw new Error(await new Response(formatProcess.stderr).text());
		}

		const [expected, actual] = await Promise.all([
			readFile(resolve(webuiDir, "src/lib/api/generated/schema.d.ts"), "utf8"),
			readFile(generatedPath, "utf8"),
		]);
		expect(actual).toBe(expected);
	}, 15_000);
});

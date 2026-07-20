import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const releasePackages = ["sdk", "playground", "cli"] as const;

export function snapshotVersion(runId: string, sha: string): string {
	if (!/^[1-9]\d*$/.test(runId)) throw new Error("run ID must be a positive integer");
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("sha must contain 7 to 40 hexadecimal characters");
	return `0.0.0-beta.run-${runId}.sha-${sha.slice(0, 7).toLowerCase()}`;
}

export function applySnapshotVersion(version: string): void {
	for (const pkg of releasePackages) {
		const path = resolve(root, "packages", pkg, "package.json");
		const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		manifest.version = version;
		writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
	if (process.argv[2] !== "apply") {
		throw new Error(
			"usage: snapshot.ts apply (--version <snapshot-version> | --run-id <github-run-id> --sha <git-sha>)",
		);
	}
	const suppliedVersion = option("version");
	const runId = option("run-id");
	const sha = option("sha");
	const version = suppliedVersion ?? (runId && sha ? snapshotVersion(runId, sha) : undefined);
	if (!version) throw new Error("provide --version or both --run-id and --sha");
	if (!/^0\.0\.0-beta\.run-[1-9]\d*\.sha-[0-9a-f]{7}$/.test(version)) {
		throw new Error(`invalid beta snapshot version: ${version}`);
	}
	applySnapshotVersion(version);
	const output = option("output");
	if (output) appendFileSync(output, `version=${version}\n`);
	console.log(`Prepared beta snapshot ${version}.`);
}

if (import.meta.main) main();

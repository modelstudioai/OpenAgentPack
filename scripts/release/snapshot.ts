import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { betaSnapshotVersion, commonReleaseVersion, releasePackageVersions } from "./channel.ts";

const root = resolve(import.meta.dirname, "../..");
const releasePackages = ["sdk", "playground", "cli"] as const;

export function snapshotVersion(baseVersion: string, sha: string, date = new Date()): string {
	if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(baseVersion)) {
		throw new Error(`base version must be X.Y.Z; found ${baseVersion}`);
	}
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("sha must contain 7 to 40 hexadecimal characters");
	if (Number.isNaN(date.getTime())) throw new Error("date must be valid");
	const utcDate = date.toISOString().slice(0, 10).replaceAll("-", "");
	return `${baseVersion}-beta-${sha.slice(0, 7).toLowerCase()}-${utcDate}`;
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
		throw new Error("usage: snapshot.ts apply (--version <snapshot-version> | --sha <git-sha>)");
	}
	const suppliedVersion = option("version");
	const sha = option("sha");
	const version =
		suppliedVersion ?? (sha ? snapshotVersion(commonReleaseVersion(releasePackageVersions()), sha) : undefined);
	if (!version) throw new Error("provide --version or --sha");
	if (!betaSnapshotVersion.test(version)) {
		throw new Error(`invalid beta snapshot version: ${version}`);
	}
	applySnapshotVersion(version);
	const output = option("output");
	if (output) appendFileSync(output, `version=${version}\n`);
	console.log(`Prepared beta snapshot ${version}.`);
}

if (import.meta.main) main();

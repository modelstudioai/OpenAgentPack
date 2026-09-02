import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseChannel = "beta" | "stable";

export interface ReleaseIdentity {
	channel: ReleaseChannel;
	version: string;
	distTag: "beta" | `beta-${string}` | "latest";
}

const root = resolve(import.meta.dirname, "../..");
const releasePackages = ["sdk", "playground", "cli"] as const;
const stableVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const betaSnapshotVersion = /^[0-9]+\.[0-9]+\.[0-9]+-beta-[0-9a-f]{7}-([0-9a-f]{8})-\d{8}$/;

export function releasePackageVersions(): string[] {
	return releasePackages.map((pkg) => {
		const manifest = JSON.parse(readFileSync(resolve(root, "packages", pkg, "package.json"), "utf8")) as {
			version?: string;
		};
		if (!manifest.version) throw new Error(`packages/${pkg}/package.json has no version`);
		return manifest.version;
	});
}

export function commonReleaseVersion(versions: readonly string[]): string {
	if (versions.length === 0) throw new Error("no release package versions found");
	const unique = [...new Set(versions)];
	if (unique.length !== 1) throw new Error(`release package versions must match; found: ${unique.join(", ")}`);
	return unique[0];
}

/** Keep main's shared beta channel stable while isolating feature-branch snapshots. */
export function betaDistTag(ref: string): "beta" | `beta-${string}` {
	if (ref === "main") return "beta";
	const slug = ref
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	if (!slug) throw new Error(`beta release ref must contain at least one letter or number; found ${ref}`);
	return `beta-${slug}-${releaseRefHash(ref)}`;
}

export function releaseRefHash(ref: string): string {
	return createHash("sha256").update(ref).digest("hex").slice(0, 8);
}

export function validateReleaseIdentity(channel: ReleaseChannel, ref: string, version: string): ReleaseIdentity {
	if (channel === "stable") {
		if (ref !== "main") throw new Error(`stable releases must run from main, not ${ref}`);
		if (!stableVersion.test(version)) throw new Error(`stable release version must be X.Y.Z; found ${version}`);
		return { channel, version, distTag: "latest" };
	}

	const distTag = betaDistTag(ref);
	const snapshotMatch = betaSnapshotVersion.exec(version);
	if (!snapshotMatch) {
		throw new Error(`beta snapshot version has an unexpected format: ${version}`);
	}
	const versionRefHash = snapshotMatch[1];
	const expectedRefHash = releaseRefHash(ref);
	if (versionRefHash !== expectedRefHash) {
		throw new Error(
			`beta snapshot version belongs to another ref; expected hash ${expectedRefHash}, found ${versionRefHash}`,
		);
	}
	return { channel, version, distTag };
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
	if (process.argv[2] !== "validate")
		throw new Error("usage: channel.ts validate --channel <beta|stable> --ref <branch>");
	const channel = option("channel");
	const ref = option("ref");
	if (channel !== "beta" && channel !== "stable") throw new Error("--channel must be beta or stable");
	if (!ref) throw new Error("--ref is required");
	const identity = validateReleaseIdentity(channel, ref, commonReleaseVersion(releasePackageVersions()));
	const output = option("output");
	if (output) {
		appendFileSync(output, `channel=${identity.channel}\nversion=${identity.version}\ndist-tag=${identity.distTag}\n`);
	}
	console.log(`Validated ${identity.channel} release ${identity.version} from ${ref} (npm tag: ${identity.distTag}).`);
}

if (import.meta.main) main();

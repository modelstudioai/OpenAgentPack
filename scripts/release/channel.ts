import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseChannel = "beta" | "stable";

export interface ReleaseIdentity {
	channel: ReleaseChannel;
	version: string;
	distTag: "beta" | "latest";
}

const root = resolve(import.meta.dirname, "../..");
const releasePackages = ["sdk", "playground", "cli"] as const;
const stableVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/;

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

export function validateReleaseIdentity(
	channel: ReleaseChannel,
	ref: string,
	version: string,
	expectedBase?: string,
): ReleaseIdentity {
	if (channel === "stable") {
		if (ref !== "main") throw new Error(`stable releases must run from main, not ${ref}`);
		if (!stableVersion.test(version)) throw new Error(`stable release version must be X.Y.Z; found ${version}`);
		return { channel, version, distTag: "latest" };
	}

	const branch = /^release\/([0-9]+\.[0-9]+\.[0-9]+)-beta$/.exec(ref);
	if (!branch) throw new Error(`beta releases must run from release/X.Y.Z-beta, not ${ref}`);
	const base = branch[1];
	if (expectedBase && base !== expectedBase) {
		throw new Error(`beta branch series ${base} does not match requested ${expectedBase}`);
	}
	if (!new RegExp(`^${base.replaceAll(".", "\\.")}-beta\\.[0-9]+$`).test(version)) {
		throw new Error(`beta package version must match ${base}-beta.N; found ${version}`);
	}
	return { channel, version, distTag: "beta" };
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
	const identity = validateReleaseIdentity(
		channel,
		ref,
		commonReleaseVersion(releasePackageVersions()),
		option("expected"),
	);
	const output = option("output");
	if (output) {
		appendFileSync(output, `channel=${identity.channel}\nversion=${identity.version}\ndist-tag=${identity.distTag}\n`);
	}
	console.log(`Validated ${identity.channel} release ${identity.version} from ${ref} (npm tag: ${identity.distTag}).`);
}

if (import.meta.main) main();

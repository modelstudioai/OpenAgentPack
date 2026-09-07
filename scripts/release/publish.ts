/**
 * 按拓扑顺序发布所有包到 npm
 * 发布前自动将 exports 从 ./src/*.ts 重写为 ./dist/*.js，发布后恢复
 * 用法: bun run scripts/release/publish.ts [--dry-run]
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertPublishManifest, rewriteExportTargets, rewriteWorkspaceDependencies } from "./package-manifest.ts";

const root = resolve(import.meta.dirname, "../..");
export const PACKAGES = ["sdk", "playground", "cli"] as const;

export function publishedPackageSpec(name: string, version: string): string {
	return `${name}@${version}`;
}

export function publishedVersionMatches(raw: string, version: string): boolean {
	try {
		const value: unknown = JSON.parse(raw);
		return value === version || (Array.isArray(value) && value.includes(version));
	} catch {
		return false;
	}
}

export function shouldSkipPublishedVersion(dryRun: boolean, published: boolean): boolean {
	return !dryRun && published;
}

export interface PublishEnvironment {
	GITHUB_ACTIONS?: string;
	GITHUB_WORKFLOW?: string;
	GITHUB_EVENT_NAME?: string;
}

export function assertPublishEnvironment(
	dryRun: boolean,
	environment: PublishEnvironment = {
		GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
		GITHUB_WORKFLOW: process.env.GITHUB_WORKFLOW,
		GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
	},
): void {
	if (
		!dryRun &&
		(environment.GITHUB_ACTIONS !== "true" ||
			environment.GITHUB_WORKFLOW !== "Publish npm" ||
			!["workflow_dispatch", "push"].includes(environment.GITHUB_EVENT_NAME ?? ""))
	) {
		throw new Error("Real npm publishing is allowed only from the GitHub Actions Publish npm workflow.");
	}
}

export function inferDistTag(version: string): string | undefined {
	const prerelease = version.match(/^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z]+)(?:[.-]|$)/);
	return prerelease?.[1];
}

export function publishCommand(dryRun: boolean, version: string, distTag?: string): string[] {
	if (dryRun) return ["npm", "pack", "--dry-run"];
	const command = ["npm", "publish", "--access", "public", "--provenance"];
	const publishTag = distTag ?? inferDistTag(version);
	if (publishTag) command.push("--tag", publishTag);
	return command;
}

function isVersionPublished(name: string, version: string): boolean {
	const result = Bun.spawnSync(["npm", "view", publishedPackageSpec(name, version), "version", "--json"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0 && publishedVersionMatches(result.stdout.toString().trim(), version);
}

export function workspaceVersions(): Map<string, string> {
	const versions = new Map<string, string>();
	for (const parent of ["apps", "packages"] as const) {
		for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifestPath = join(root, parent, entry.name, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string };
			if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
		}
	}
	return versions;
}

/**
 * 将 package.json 的 exports 从 ./src/*.ts 重写为 ./dist/*.js
 * 返回原始文件内容以便后续恢复
 */
export function rewriteManifestForPublish(pkgDir: string, versions: ReadonlyMap<string, string>): string {
	const pkgJsonPath = join(pkgDir, "package.json");
	const original = readFileSync(pkgJsonPath, "utf8");
	const pkg = JSON.parse(original) as Record<string, unknown>;
	pkg.exports = rewriteExportTargets(pkg.exports, (sourceExport) => resolvePublishExport(pkgDir, sourceExport));
	rewriteWorkspaceDependencies(pkg, versions);
	assertPublishManifest(pkg, (target) => existsSync(join(pkgDir, target)), pkgDir);

	writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	return original;
}

function resolvePublishExport(pkgDir: string, sourceExport: string): string {
	const candidates = sourceExport.startsWith("./src/")
		? [
				sourceExport.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js"),
				sourceExport.replace(/^\.\/src\//, "./dist/src/").replace(/\.ts$/, ".js"),
			]
		: [sourceExport.replace(/^\.\/bin\//, "./dist/bin/").replace(/\.ts$/, ".js")];

	const match = candidates.find((candidate) => existsSync(join(pkgDir, candidate)));
	if (!match) {
		throw new Error(`Cannot rewrite export '${sourceExport}': none of ${candidates.join(", ")} exists.`);
	}
	return match;
}

export function restorePackageJson(pkgDir: string, original: string): void {
	writeFileSync(join(pkgDir, "package.json"), original);
}

export function stageLicense(pkgDir: string): string | undefined {
	const packageLicense = join(pkgDir, "LICENSE");
	const original = trackedFileContents(packageLicense);
	writeFileSync(packageLicense, readFileSync(join(root, "LICENSE"), "utf8"));
	return original;
}

export function restoreLicense(pkgDir: string, original: string | undefined): void {
	const packageLicense = join(pkgDir, "LICENSE");
	if (original === undefined) unlinkSync(packageLicense);
	else writeFileSync(packageLicense, original);
}

function trackedFileContents(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", relative(root, path)], {
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	});
	return tracked.exitCode === 0 ? readFileSync(path, "utf8") : undefined;
}

function main(): number {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const tagIndex = args.indexOf("--tag");
	const distTag = tagIndex === -1 ? undefined : args[tagIndex + 1];
	if (tagIndex !== -1 && (!distTag || !/^[a-z][a-z0-9-]*$/.test(distTag))) {
		throw new Error("--tag must be a lowercase npm dist-tag");
	}
	assertPublishEnvironment(dryRun);

	console.log(`Publishing packages${dryRun ? " (dry-run)" : ""}...\n`);
	const versions = workspaceVersions();

	for (const pkg of PACKAGES) {
		const pkgDir = join(root, "packages", pkg);
		const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
			name: string;
			version: string;
		};
		const alreadyPublished = !dryRun && isVersionPublished(manifest.name, manifest.version);
		if (shouldSkipPublishedVersion(dryRun, alreadyPublished)) {
			console.log(`\n--- Skipping ${publishedPackageSpec(manifest.name, manifest.version)} (already published) ---`);
			continue;
		}

		const cmd = publishCommand(dryRun, manifest.version, distTag);

		console.log(`\n--- Publishing ${manifest.name} ---`);
		let originalLicense: string | undefined;
		let original: string | undefined;
		let licenseStaged = false;
		let failedExitCode: number | undefined;
		try {
			originalLicense = stageLicense(pkgDir);
			licenseStaged = true;
			original = rewriteManifestForPublish(pkgDir, versions);
			const proc = Bun.spawnSync(cmd, {
				cwd: pkgDir,
				stdio: ["inherit", "inherit", "inherit"],
			});
			if (proc.exitCode !== 0) {
				console.error(`\nFailed to publish ${manifest.name}`);
				failedExitCode = proc.exitCode ?? 1;
			}
		} finally {
			if (original !== undefined) restorePackageJson(pkgDir, original);
			if (licenseStaged) restoreLicense(pkgDir, originalLicense);
		}
		if (failedExitCode !== undefined) return failedExitCode;
	}

	console.log("\n✓ All packages published successfully.");
	return 0;
}

if (import.meta.main) process.exit(main());

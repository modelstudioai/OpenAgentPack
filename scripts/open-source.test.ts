import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** 可安全 readFileSync 的路径：存在且最终目标是普通文件（跳过目录、目录符号链接）。 */
function isReadableRegularFile(absolute: string): boolean {
	try {
		const link = lstatSync(absolute);
		if (link.isSymbolicLink()) {
			return statSync(absolute).isFile();
		}
		return link.isFile();
	} catch {
		return false;
	}
}

function publicWorktreeFiles(): string[] {
	return output(["git", "ls-files", "--cached", "--others", "--exclude-standard"])
		.trim()
		.split("\n")
		.filter((file) => file && isReadableRegularFile(resolve(root, file)));
}

function output(command: string[]): string {
	const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}

describe("open-source repository invariants", () => {
	test("public packages share one version for on-demand Playground resolution", () => {
		const packagePaths = ["packages/sdk/package.json", "packages/playground/package.json", "packages/cli/package.json"];
		const manifests = packagePaths.map(
			(file) => JSON.parse(readFileSync(resolve(root, file), "utf8")) as { name: string; version: string },
		);
		expect(new Set(manifests.map((manifest) => manifest.version)).size).toBe(1);

		const changesets = JSON.parse(readFileSync(resolve(root, ".changeset/config.json"), "utf8")) as {
			fixed: string[][];
		};
		expect(changesets.fixed).toContainEqual(manifests.map((manifest) => manifest.name));
	});

	test("published packages have no runtime dependency on private workspaces", () => {
		const packageFiles = output(["rg", "--files", "-g", "package.json"]).trim().split("\n").filter(Boolean);
		const manifests = packageFiles.map(
			(file) =>
				JSON.parse(readFileSync(resolve(root, file), "utf8")) as {
					name?: string;
					private?: boolean;
					dependencies?: Record<string, string>;
					optionalDependencies?: Record<string, string>;
					peerDependencies?: Record<string, string>;
				},
		);
		const privateNames = new Set(
			manifests.filter((manifest) => manifest.private && manifest.name).map((manifest) => manifest.name as string),
		);
		const invalid: string[] = [];
		for (const manifest of manifests.filter((entry) => entry.name?.startsWith("@openagentpack/") && !entry.private)) {
			for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
				for (const name of Object.keys(dependencies ?? {})) {
					if (privateNames.has(name)) invalid.push(`${manifest.name} -> ${name}`);
				}
			}
		}
		expect(invalid).toEqual([]);
	});

	test("workspace identity matches the lockfile", () => {
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name: string };
		const lockfile = readFileSync(resolve(root, "bun.lock"), "utf8");
		expect(lockfile).toContain(`"name": "${manifest.name}"`);
		expect(lockfile).not.toContain('"name": "open-cma-workspace"');
	});

	test("generated internal artifacts are absent", () => {
		expect(existsSync(resolve(root, "apps/webui/outputs"))).toBe(false);
		expect(publicWorktreeFiles().filter((file) => file.startsWith("apps/webui/work/"))).toEqual([]);
		for (const pkg of ["sdk", "cli", "playground"]) {
			expect(existsSync(resolve(root, `packages/${pkg}/LICENSE`))).toBe(false);
		}
	});

	test("the vendored skill archive carries the project license", () => {
		const listing = output(["unzip", "-Z1", "examples/qoder/bailian-cli/skills/bailian-cli.zip"]);
		expect(listing.split("\n")).toContain("LICENSE");
	});

	test("all local Markdown links resolve", () => {
		const files = output(["rg", "--files", "-g", "*.md"]).trim().split("\n").filter(Boolean);
		const missing: string[] = [];
		for (const file of files) {
			const body = readFileSync(resolve(root, file), "utf8");
			for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
				let target = match[1].split("#")[0].split("?")[0].replace(/^<|>$/g, "");
				if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
				target = decodeURIComponent(target);
				if (!existsSync(resolve(root, dirname(file), target))) missing.push(`${file} -> ${target}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("third-party GitHub Actions are pinned to full commit SHAs", () => {
		const workflows = output(["rg", "--files", ".github/workflows", "-g", "*.yml", "-g", "*.yaml"])
			.trim()
			.split("\n")
			.filter(Boolean);
		const unpinned: string[] = [];
		for (const file of workflows) {
			const body = readFileSync(resolve(root, file), "utf8");
			for (const match of body.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
				if (!/^[0-9a-f]{40}$/.test(match[1])) unpinned.push(`${file} -> ${match[1]}`);
			}
		}
		expect(unpinned).toEqual([]);
	});

	test("npm release is opt-in and cannot be cancelled mid-publish", () => {
		const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
		expect(workflow).toContain("if: vars.NPM_RELEASE_ENABLED == 'true'");
		expect(workflow).toContain("cancel-in-progress: false");
		expect(workflow).toContain("workflow_dispatch:");
	});

	test("public worktree has no high-confidence secrets or internal machine references", () => {
		const findings: string[] = [];
		const patterns = [
			/github_pat_[A-Za-z0-9_]{20,}/,
			/gh[pousr]_[A-Za-z0-9_]{20,}/,
			/AKIA[0-9A-Z]{16}/,
			/npm_[A-Za-z0-9]{20,}/,
			/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
			/\/Users\/[A-Za-z0-9._-]+\//,
			new RegExp(["registry", "anpm", "alibaba-inc", "com"].join("\\.")),
			new RegExp(["gitlab", "alibaba-inc", "com"].join("\\.")),
		];
		for (const file of publicWorktreeFiles()) {
			if (file === "scripts/open-source.test.ts") continue;
			const absolute = resolve(root, file);
			let body: string;
			try {
				body = readFileSync(absolute, "utf8");
			} catch (error) {
				// 竞态或残留目录项：跳过不可读路径
				if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
				throw error;
			}
			if (body.includes("\0")) continue;
			for (const pattern of patterns) {
				if (pattern.test(body)) findings.push(`${file} -> ${pattern.source}`);
			}
		}
		expect(findings).toEqual([]);
	});
});

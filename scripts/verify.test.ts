import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	assertPublishManifest,
	rewriteExportTargets,
	rewriteWorkspaceDependencies,
} from "./release/package-manifest.ts";
import { profileSteps, resolveComparisonBase, verificationProfiles } from "./verify.ts";

describe("verification profiles", () => {
	test("architecture checks ignore generated distribution trees", async () => {
		const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
		expect(packageJson.scripts["check:architecture:deps"]).toContain("--exclude '(^|/)dist/'");
	});

	test("release is full plus artifact checks", () => {
		expect(profileSteps("release")).toEqual([
			...profileSteps("full"),
			"build-packages",
			"publish-dry-run",
			"package-smoke",
		]);
	});

	test("every profile is non-empty and contains no duplicate steps", () => {
		for (const steps of Object.values(verificationProfiles)) {
			expect(steps.length).toBeGreaterThan(0);
			expect(new Set(steps).size).toBe(steps.length);
		}
	});

	test("full is the complete CI gate", () => {
		expect(profileSteps("full")).toEqual([
			"lint",
			"lint-changed",
			"typecheck",
			"architecture",
			"audit",
			"test",
			"build-webui",
		]);
	});

	test("rejects an explicit BASE that is not a commit", () => {
		expect(() => resolveComparisonBase("not-a-real-commit")).toThrow("is not a commit");
	});
});

describe("publish manifest", () => {
	test("rewrites nested Bun export conditions to built artifacts", () => {
		const exports = {
			".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./events": { bun: "./src/events.ts", import: "./dist/events.js" },
		};
		const resolve = (target: string) => target.replace("./src/", "./dist/").replace(/\.ts$/, ".js");

		expect(rewriteExportTargets(exports, resolve)).toEqual({
			".": { bun: "./dist/index.js", types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./events": { bun: "./dist/events.js", import: "./dist/events.js" },
		});
	});

	test("rejects missing or unpacked manifest targets", () => {
		expect(() =>
			assertPublishManifest({ files: ["dist"], exports: { bun: "./src/index.ts" } }, () => false, "fixture"),
		).toThrow("does not exist");
		expect(() =>
			assertPublishManifest({ files: ["dist"], exports: { bun: "./src/index.ts" } }, () => true, "fixture"),
		).toThrow("excluded by package.json files");
	});

	test("rewrites workspace protocols to publishable package versions", () => {
		const manifest = {
			dependencies: { "@openagentpack/sdk": "workspace:*" },
			peerDependencies: { "@openagentpack/playbooks": "workspace:^" },
		};
		rewriteWorkspaceDependencies(
			manifest,
			new Map([
				["@openagentpack/sdk", "1.0.1-beta.5"],
				["@openagentpack/playbooks", "1.0.1-beta.3"],
			]),
		);
		expect(manifest).toEqual({
			dependencies: { "@openagentpack/sdk": "1.0.1-beta.5" },
			peerDependencies: { "@openagentpack/playbooks": "^1.0.1-beta.3" },
		});
	});

	test("rejects workspace protocols left in a published manifest", () => {
		expect(() =>
			assertPublishManifest({ dependencies: { "@openagentpack/sdk": "workspace:*" } }, () => true, "fixture"),
		).toThrow("still uses 'workspace:*'");
	});
});

describe("public dependency resolution", () => {
	test("lockfile contains no private registry URLs", () => {
		const lockfile = readFileSync(resolve(import.meta.dirname, "../bun.lock"), "utf8");
		expect(lockfile).not.toContain(["registry", "anpm", "alibaba-inc", "com"].join("."));
	});
});

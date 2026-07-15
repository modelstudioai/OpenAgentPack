import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type VerificationProfile = "scoped" | "push" | "full" | "release";

type StepId =
	| "lint"
	| "lint-changed"
	| "typecheck"
	| "typecheck-affected"
	| "architecture"
	| "audit"
	| "test"
	| "build-webui"
	| "build-packages"
	| "publish-dry-run"
	| "package-smoke";

type Step = {
	description: string;
	run: (profile: VerificationProfile) => number;
};

const root = resolve(import.meta.dirname, "..");

function spawn(command: string[], env?: Record<string, string | undefined>): number {
	const childEnv = { ...process.env };
	for (const [key, value] of Object.entries(env ?? {})) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const child = Bun.spawnSync(command, {
		cwd: root,
		env: childEnv,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return child.exitCode ?? 1;
}

function output(command: string[]): string {
	const child = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "ignore" });
	return child.exitCode === 0 ? child.stdout.toString().trim() : "";
}

function worktreeChangedFiles(): string[] {
	const tracked = output(["git", "diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
	const untracked = output(["git", "ls-files", "--others", "--exclude-standard"]);
	return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
}

function gitCommitExists(ref: string): boolean {
	return Bun.spawnSync(["git", "cat-file", "-e", `${ref}^{commit}`], { cwd: root, stderr: "ignore" }).exitCode === 0;
}

export function resolveComparisonBase(explicitBase = process.env.BASE): string | undefined {
	if (explicitBase && !/^0+$/.test(explicitBase)) {
		if (gitCommitExists(explicitBase)) return explicitBase;
		if (process.env.GITHUB_ACTIONS !== "true") {
			throw new Error(`Verification BASE '${explicitBase}' is not a commit.`);
		}
		console.warn(`Verification BASE '${explicitBase}' is unavailable after a history rewrite; using a local fallback.`);
	}
	return output(["git", "merge-base", "HEAD", "origin/HEAD"]) || output(["git", "rev-parse", "HEAD^"]) || undefined;
}

const affectedTypechecks = [
	{ prefix: "scripts/", script: "typecheck:scripts" },
	{ prefix: "packages/sdk/", script: "typecheck:sdk" },
	{ prefix: "packages/cli/", script: "typecheck:cli" },
	{ prefix: "packages/playbooks/", script: "typecheck:playbooks" },
	{ prefix: "packages/playground/", script: "typecheck:playground" },
	{ prefix: "apps/webui/", script: "typecheck:webui" },
	{ prefix: "apps/server/", script: "typecheck:server" },
] as const;

function runAffectedTypechecks(): number {
	const files = worktreeChangedFiles();
	const scripts = affectedTypechecks.filter(({ prefix }) => files.some((file) => file.startsWith(prefix)));
	for (const { script } of scripts) {
		const exitCode = spawn(["bun", "run", script]);
		if (exitCode !== 0) return exitCode;
	}
	return 0;
}

function runPublishDryRun(): number {
	const packageJson = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")) as { version: string };
	const prereleaseTag = packageJson.version.match(/-([0-9A-Za-z]+)(?:[.-]|$)/)?.[1];
	const command = ["bun", "run", "scripts/release/publish.ts", "--dry-run"];
	if (prereleaseTag) command.push("--tag", prereleaseTag);
	return spawn(command);
}

const steps: Record<StepId, Step> = {
	lint: { description: "Lint and formatting", run: () => spawn(["bun", "run", "lint"]) },
	"lint-changed": {
		description: "Lint changed lines/files",
		run: (profile) => {
			try {
				const base = profile === "scoped" ? undefined : resolveComparisonBase();
				const includeWorktree = profile === "full" || profile === "release" ? "1" : undefined;
				return spawn(["bun", "run", "lint:changed"], { BASE: base, INCLUDE_WORKTREE: includeWorktree });
			} catch (error) {
				console.error(error instanceof Error ? error.message : error);
				return 2;
			}
		},
	},
	typecheck: { description: "Type check every workspace", run: () => spawn(["bun", "run", "typecheck"]) },
	"typecheck-affected": { description: "Type check affected workspaces", run: runAffectedTypechecks },
	architecture: { description: "Architecture conformance", run: () => spawn(["bun", "run", "check:architecture"]) },
	audit: { description: "Dependency vulnerability audit", run: () => spawn(["bun", "run", "audit"]) },
	test: { description: "All tests", run: () => spawn(["bun", "run", "test"]) },
	"build-webui": { description: "WebUI production build", run: () => spawn(["bun", "run", "build:webui"]) },
	"build-packages": { description: "Build publishable packages", run: () => spawn(["bun", "run", "build:packages"]) },
	"publish-dry-run": { description: "Inspect npm tarballs with a publish dry-run", run: runPublishDryRun },
	"package-smoke": {
		description: "Install and execute packed packages as an external Node.js consumer",
		run: () => spawn(["bun", "run", "scripts/release/smoke-packed.ts"]),
	},
};

const fullSteps: StepId[] = ["lint", "lint-changed", "typecheck", "architecture", "audit", "test", "build-webui"];

export const verificationProfiles: Record<VerificationProfile, readonly StepId[]> = {
	scoped: ["lint-changed", "typecheck-affected"],
	push: ["typecheck", "architecture", "test", "lint-changed"],
	full: fullSteps,
	release: [...fullSteps, "build-packages", "publish-dry-run", "package-smoke"],
};

export function profileSteps(profile: VerificationProfile): readonly string[] {
	return verificationProfiles[profile];
}

export function runProfile(profile: VerificationProfile, onlyStep?: string): number {
	const selected = onlyStep ? [onlyStep] : verificationProfiles[profile];
	for (const id of selected) {
		if (!verificationProfiles[profile].includes(id as StepId)) {
			console.error(`Verification step '${id}' does not belong to profile '${profile}'.`);
			return 2;
		}
		const step = steps[id as StepId];
		console.log(`\n=== ${id}: ${step.description} ===`);
		const exitCode = step.run(profile);
		if (exitCode !== 0) {
			console.error(`\nVerification '${profile}' failed at '${id}'.`);
			return exitCode;
		}
	}
	console.log(`\n✓ Verification '${profile}' passed.`);
	return 0;
}

function isProfile(value: string | undefined): value is VerificationProfile {
	return value !== undefined && value in verificationProfiles;
}

function main(): number {
	const [profileArg, ...args] = process.argv.slice(2);
	if (!isProfile(profileArg)) {
		console.error("Usage: bun scripts/verify.ts <scoped|push|full|release> [--step <id> | --list-steps]");
		return 2;
	}
	if (args.includes("--list-steps")) {
		process.stdout.write(JSON.stringify(profileSteps(profileArg)));
		return 0;
	}
	const stepIndex = args.indexOf("--step");
	return runProfile(profileArg, stepIndex >= 0 ? args[stepIndex + 1] : undefined);
}

if (import.meta.main) process.exit(main());

import { existsSync } from "node:fs";

const highRiskPathPatterns = [
	/^\.github\/workflows\//,
	/^scripts\/release\//,
	/^(?:package\.json|bun\.lock)$/,
	/^packages\/sdk\/src\/internal\/(?:parser\/|types\/(?:config|session)\.ts|providers\/(?:interface|capabilities|registry|base-client)\.ts)/,
];

export function requiresMaintainerEvidence(files: readonly string[]): boolean {
	return files.some((file) => highRiskPathPatterns.some((pattern) => pattern.test(file)));
}

function sectionHasContent(body: string, heading: string): boolean {
	const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = body.match(new RegExp(`^## ${escapedHeading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$)`, "mi"));
	if (!match) return false;
	return (
		match[1]
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/- \[ \] .*/g, "")
			.trim().length > 0
	);
}

export function validateMaintainerEvidence(body: string, files: readonly string[]): string | undefined {
	if (!requiresMaintainerEvidence(files)) return undefined;
	const missing = ["Behavior / risk", "Validation"].filter((heading) => !sectionHasContent(body, heading));
	if (missing.length === 0) return undefined;
	return `High-risk changes require a non-empty ${missing.map((heading) => `## ${heading}`).join(" and ")} section.`;
}

function changedFiles(base: string, head: string): string[] {
	const result = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=ACMR", base, head], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Could not read changed files.");
	return result.stdout.toString().split("\n").filter(Boolean);
}

function main(): number {
	if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
		console.log("Not a pull request; maintainer-evidence check skipped.");
		return 0;
	}
	const base = process.env.BASE_SHA;
	const head = process.env.HEAD_SHA;
	if (!base || !head || !existsSync(".git"))
		throw new Error("BASE_SHA and HEAD_SHA are required for pull-request evidence checks.");
	const files = changedFiles(base, head);
	const error = validateMaintainerEvidence(process.env.PR_BODY ?? "", files);
	if (!error) {
		console.log(
			requiresMaintainerEvidence(files)
				? "Maintainer evidence supplied."
				: "Low-risk change; maintainer evidence is optional.",
		);
		return 0;
	}
	console.error(`::error::${error}`);
	console.error(
		"Describe the user-visible behavior or compatibility risk, then give the test command, test case, or manual reproduction used to validate it.",
	);
	return 1;
}

if (import.meta.main) process.exit(main());

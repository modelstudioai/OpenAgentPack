import * as p from "@clack/prompts";
import { UserError } from "@openagentpack/sdk";
import chalk from "chalk";
import { writeJson } from "../runtime.ts";
import {
	disableLocalVersioning,
	enableLocalVersioning,
	getLocalVersionStatus,
	type LocalProjectVersion,
	type LocalVersionPreview,
	type LocalVersionStatus,
	listLocalVersions,
	previewLocalVersion,
	restoreLocalVersion,
} from "../versioning/local-git.ts";

export async function versionStatusCommand(options: { file: string; json?: boolean }): Promise<void> {
	const status = await getLocalVersionStatus(options.file);
	if (options.json) return writeJson(status);
	renderStatus(status);
}

export async function versionEnableCommand(options: { file: string; json?: boolean }): Promise<void> {
	const result = await enableLocalVersioning(options.file);
	if (options.json) return writeJson(result);
	if (result.version) console.log(`Created baseline version ${result.version.short_commit} ${result.version.message}`);
	else console.log("Current agents.yaml is already versioned; no commit was created.");
	console.log("Automatic versioning is enabled for this agents.yaml.");
	renderStatus(result.git);
}

export async function versionDisableCommand(options: { file: string; json?: boolean }): Promise<void> {
	const status = await disableLocalVersioning(options.file);
	if (options.json) return writeJson(status);
	console.log("Automatic versioning is disabled for this agents.yaml.");
	renderStatus(status);
}

export async function versionListCommand(options: {
	file: string;
	limit?: number;
	cursor?: string;
	json?: boolean;
}): Promise<void> {
	const page = await listLocalVersions(options.file, { limit: options.limit, cursor: options.cursor });
	if (options.json) return writeJson(page);
	if (page.versions.length === 0) {
		console.log("No versions of agents.yaml exist on the current branch.");
		return;
	}
	for (const version of page.versions) console.log(formatVersion(version));
	if (page.next_cursor) console.log(chalk.dim(`Next cursor: ${page.next_cursor}`));
}

export async function versionPreviewCommand(commit: string, options: { file: string; json?: boolean }): Promise<void> {
	const preview = await previewLocalVersion(options.file, commit);
	if (options.json) return writeJson(preview);
	renderPreview(preview);
}

export async function versionRestoreCommand(
	commit: string,
	options: { file: string; yes?: boolean; json?: boolean },
): Promise<void> {
	const preview = await previewLocalVersion(options.file, commit);
	if (!options.json) renderPreview(preview);
	if (!preview.can_restore) {
		throw new UserError(
			preview.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
				preview.blockers[0] ??
				"This version cannot be restored.",
		);
	}
	if (!options.yes) {
		const confirmed = await p.confirm({
			message: "Restore this version to the agents.yaml working tree?",
			output: process.stderr,
		});
		if (p.isCancel(confirmed) || !confirmed) {
			p.cancel("Restore cancelled. agents.yaml was not changed.", { output: process.stderr });
			return;
		}
	}
	const restored = await restoreLocalVersion(options.file, commit, {
		head: preview.base_head,
		sourceRevision: preview.base_source_revision,
	});
	if (options.json) return writeJson(restored);
	console.log(`Restored ${commit.slice(0, 12)} to the working tree. HEAD was not changed.`);
}

function renderStatus(status: LocalVersionStatus): void {
	console.log(`Git available: ${status.git_available ? "yes" : "no"}`);
	console.log(`Automatic versioning: ${status.enabled ? "enabled" : "disabled"}`);
	console.log(`Repository: ${status.repository_root ?? "none"}`);
	console.log(`Config path: ${status.config_path ?? "none"}`);
	console.log(`Branch: ${status.branch ?? "none"}`);
	console.log(`HEAD: ${status.head ?? "none"}`);
	console.log(`agents.yaml: ${status.config_status}${status.config_versioned ? ", versioned" : ", unversioned"}`);
	const blockers = [...new Set([...status.commit_blockers, ...status.restore_blockers])];
	for (const blocker of blockers) console.log(chalk.yellow(`Blocker: ${blocker}`));
}

function formatVersion(version: LocalProjectVersion): string {
	return `${chalk.yellow(version.short_commit)} ${version.authored_at} ${version.message} ${chalk.dim(`(${version.author_name})`)}`;
}

function renderPreview(preview: LocalVersionPreview): void {
	console.log(chalk.bold(`Version ${preview.commit}`));
	console.log(chalk.red("--- working tree"));
	console.log(chalk.green(`+++ ${preview.commit}`));
	for (const line of buildLineDiff(preview.before_yaml, preview.after_yaml)) {
		if (line.kind === "deletion") console.log(chalk.red(`-${line.text}`));
		else if (line.kind === "addition") console.log(chalk.green(`+${line.text}`));
		else console.log(chalk.dim(` ${line.text}`));
	}
	for (const diagnostic of preview.diagnostics) {
		const color =
			diagnostic.severity === "error" ? chalk.red : diagnostic.severity === "warning" ? chalk.yellow : chalk.dim;
		console.log(color(`${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`));
	}
	for (const blocker of preview.blockers) console.log(chalk.yellow(`blocker: ${blocker}`));
	console.log(`Can restore: ${preview.can_restore ? "yes" : "no"}`);
}

type DiffLine = { kind: "context" | "addition" | "deletion"; text: string };

function buildLineDiff(beforeSource: string, afterSource: string): DiffLine[] {
	const beforeLines = yamlLines(beforeSource);
	const afterLines = yamlLines(afterSource);
	const maximumDistance = beforeLines.length + afterLines.length;
	const frontier = new Map<number, number>([[1, 0]]);
	const traces: Array<Map<number, number>> = [];

	for (let editDistance = 0; editDistance <= maximumDistance; editDistance++) {
		traces.push(new Map(frontier));
		for (let diagonal = -editDistance; diagonal <= editDistance; diagonal += 2) {
			const deletionStart = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
			const additionStart = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
			const startsWithAddition =
				diagonal === -editDistance || (diagonal !== editDistance && deletionStart < additionStart);
			let beforeIndex = startsWithAddition ? (frontier.get(diagonal + 1) ?? 0) : deletionStart + 1;
			let afterIndex = beforeIndex - diagonal;
			while (
				beforeIndex < beforeLines.length &&
				afterIndex < afterLines.length &&
				beforeLines[beforeIndex] === afterLines[afterIndex]
			) {
				beforeIndex += 1;
				afterIndex += 1;
			}
			frontier.set(diagonal, beforeIndex);
			if (beforeIndex >= beforeLines.length && afterIndex >= afterLines.length) {
				return backtrackDiff(beforeLines, afterLines, traces, editDistance);
			}
		}
	}
	return [];
}

function backtrackDiff(
	beforeLines: string[],
	afterLines: string[],
	traces: Array<Map<number, number>>,
	finalDistance: number,
): DiffLine[] {
	let beforeIndex = beforeLines.length;
	let afterIndex = afterLines.length;
	const reversedLines: DiffLine[] = [];
	for (let editDistance = finalDistance; editDistance >= 0; editDistance--) {
		const frontier = traces[editDistance]!;
		const diagonal = beforeIndex - afterIndex;
		const deletionStart = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
		const additionStart = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
		const cameFromAddition = diagonal === -editDistance || (diagonal !== editDistance && deletionStart < additionStart);
		const previousDiagonal = cameFromAddition ? diagonal + 1 : diagonal - 1;
		const previousBeforeIndex = frontier.get(previousDiagonal) ?? 0;
		const previousAfterIndex = previousBeforeIndex - previousDiagonal;
		while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
			reversedLines.push({ kind: "context", text: beforeLines[beforeIndex - 1]! });
			beforeIndex -= 1;
			afterIndex -= 1;
		}
		if (editDistance === 0) break;
		if (beforeIndex === previousBeforeIndex) {
			reversedLines.push({ kind: "addition", text: afterLines[afterIndex - 1]! });
			afterIndex -= 1;
		} else {
			reversedLines.push({ kind: "deletion", text: beforeLines[beforeIndex - 1]! });
			beforeIndex -= 1;
		}
	}
	return reversedLines.reverse();
}

function yamlLines(source: string): string[] {
	const lines = source.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

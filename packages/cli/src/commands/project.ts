import * as prompts from "@clack/prompts";
import {
	commitProjectBuild,
	createDirectoryWorkspaceVersionService,
	executeProjectPublish,
	initializeDirectoryProject,
	planProjectPublish,
	previewProjectBuild,
	validateDirectoryProject,
} from "@openagentpack/project-workspace";
import { UserError } from "@openagentpack/sdk";
import chalk from "chalk";
import { ensureCredentials } from "../credentials.ts";
import { log } from "../logger.ts";
import { renderDiagnostics } from "../render-diagnostics.ts";
import { renderRuntimeFeedback } from "../render-feedback.ts";
import { writeJson } from "../runtime.ts";
import { formatResourceLabel } from "../utils/address-utils.ts";
import { workbenchCommand } from "./playground.ts";

interface ProjectOptions {
	project?: string;
	json?: boolean;
}

function projectRoot(options: ProjectOptions): string {
	return options.project ?? ".";
}

export async function projectInitCommand(options: ProjectOptions): Promise<void> {
	const result = await initializeDirectoryProject({ projectRoot: projectRoot(options) });
	if (options.json) return writeJson(result);
	log.success(
		result.converted_from_yaml ? "Converted agents.yaml into a directory project." : "Created directory project.",
	);
	if (result.state_migrated) log.success("Copied agents.state.json to .openagentpack/state.json.");
	console.log(`Project: ${result.project_root}`);
	console.log(`Baseline version: ${result.baseline_version}`);
}

export async function projectValidateCommand(options: ProjectOptions): Promise<void> {
	const inspection = await validateDirectoryProject(projectRoot(options));
	if (options.json) return writeJson(inspection);
	renderDiagnostics([...inspection.diagnostics, ...inspection.warnings]);
	if (inspection.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		throw new UserError("Directory project is invalid.");
	}
	log.success(`Project is valid (${inspection.project_revision.slice(0, 12)}).`);
}

export async function projectBuildCommand(
	options: ProjectOptions & { dryRun?: boolean; yes?: boolean },
): Promise<void> {
	const preview = await previewProjectBuild(projectRoot(options));
	if (options.json) {
		if (options.dryRun) return writeJson(preview);
	}
	if (!options.json) renderDiagnostics([...preview.diagnostics, ...preview.warnings]);
	if (!preview.can_build) throw new UserError("Directory project is invalid and cannot be built.");
	if (!options.json) {
		const sourcePreview = await loadBuildSourcePreview(preview.project_root);
		if (sourcePreview.projectRevision && sourcePreview.projectRevision !== preview.project_revision) {
			throw new UserError("Project source changed. Preview Build again.");
		}
		renderBuildSourcePreview(sourcePreview);
		for (const move of preview.organization_moves) {
			console.log(
				chalk.yellow(`move ${move.resource_type}.${move.resource_id}: ${move.from} -> ${move.to} (${move.reason})`),
			);
		}
	}
	if (options.dryRun) return;
	if (!options.yes) {
		const confirmed = await prompts.confirm({
			message: "Write the generated Build and organize shared skills?",
			output: process.stderr,
		});
		if (prompts.isCancel(confirmed) || !confirmed) {
			prompts.cancel("Build cancelled. Project files were not changed.", { output: process.stderr });
			return;
		}
	}
	const result = await commitProjectBuild({
		projectRoot: preview.project_root,
		baseRevision: preview.project_revision,
	});
	if (options.json) return writeJson(result.manifest);
	log.success(`Build created at .openagentpack/build/agents.yaml (${result.manifest.yaml_hash.slice(0, 12)}).`);
}

export async function projectPublishCommand(
	options: ProjectOptions & { yes?: boolean; provider?: string; refresh?: boolean; concurrency?: number },
): Promise<void> {
	ensureCredentials();
	const preview = await planProjectPublish(projectRoot(options), {
		provider: options.provider,
		refresh: options.refresh,
		onFeedback: options.json ? undefined : renderRuntimeFeedback,
		quiet: options.json,
	});
	if (!options.json) renderDiagnostics(preview.planned.plan.diagnostics);
	if (preview.planned.plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		throw new UserError("Cannot Publish: resolve the plan errors first.");
	}
	const actions = preview.planned.plan.actions.filter((action) => action.action !== "no-op");
	if (!options.json) {
		for (const action of actions) {
			const color = action.action === "create" ? chalk.green : action.action === "update" ? chalk.yellow : chalk.red;
			console.log(
				color(
					`${action.action === "create" ? "+" : action.action === "update" ? "~" : "-"} ${formatResourceLabel(action.address)}`,
				),
			);
		}
	}
	if (!options.yes) {
		const confirmed = await prompts.confirm({
			message:
				actions.length === 0
					? "Publish this Build and record its version?"
					: `Publish ${actions.length} remote change(s)?`,
			output: process.stderr,
		});
		if (prompts.isCancel(confirmed) || !confirmed) {
			prompts.cancel("Publish cancelled. No remote resources were changed.", { output: process.stderr });
			return;
		}
	}
	const result = await executeProjectPublish({
		projectRoot: preview.project_root,
		expectedProjectRevision: preview.project_revision,
		expectedYamlHash: preview.build_manifest.yaml_hash,
		expectedPlanFingerprint: preview.plan_fingerprint,
		provider: options.provider,
		refresh: options.refresh,
		concurrency: options.concurrency,
		policy: "force",
		onFeedback: options.json ? undefined : renderRuntimeFeedback,
	});
	if (options.json) return writeJson(result);
	const successful = result.execution?.results.filter((entry) => entry.status === "success").length ?? 0;
	log.success(`Publish complete. ${successful} remote action(s) succeeded.`);
	if (result.version) log.success(`Created project version ${result.version.short_version}.`);
	if (result.working_tree_changed)
		log.warn("Project files changed during Publish. The published Build is preserved, but a new Build is required.");
}

export async function projectWorkbenchCommand(
	options: ProjectOptions & { port?: string; open?: boolean },
): Promise<void> {
	await workbenchCommand({ project: projectRoot(options), port: options.port, open: options.open });
}

export async function projectVersionEnableCommand(options: ProjectOptions): Promise<void> {
	const result = await createDirectoryWorkspaceVersionService(projectRoot(options)).enable(
		"Initialize project versions",
	);
	if (options.json) return writeJson(result);
	console.log(
		result.version
			? `Created baseline ${result.version.short_version}.`
			: "Current project source is already versioned.",
	);
	console.log("Project versioning is enabled.");
}

export async function projectVersionDisableCommand(options: ProjectOptions): Promise<void> {
	const result = await createDirectoryWorkspaceVersionService(projectRoot(options)).disable();
	if (options.json) return writeJson(result);
	console.log("Project versioning is disabled. Existing versions were kept.");
}

export async function projectVersionStatusCommand(options: ProjectOptions): Promise<void> {
	const status = await createDirectoryWorkspaceVersionService(projectRoot(options)).status();
	if (options.json) return writeJson(status);
	console.log(`Versioning: ${status.enabled ? "enabled" : "disabled"}`);
	console.log(`Head: ${status.head_version ?? "none"}`);
	console.log(`Source: ${status.source_status}`);
	console.log(`Store: ${status.store_root}`);
	for (const blocker of [...new Set([...status.write_blockers, ...status.restore_blockers])])
		console.log(chalk.yellow(`Blocker: ${blocker}`));
}

export async function projectVersionListCommand(
	options: ProjectOptions & { limit?: number; cursor?: string },
): Promise<void> {
	const page = await createDirectoryWorkspaceVersionService(projectRoot(options)).listVersions({
		limit: options.limit,
		cursor: options.cursor,
	});
	if (options.json) return writeJson(page);
	for (const version of page.versions)
		console.log(
			`${chalk.yellow(version.short_version)} ${version.created_at} ${version.message} ${chalk.dim(`(${version.created_by})`)}`,
		);
	if (page.versions.length === 0) console.log("No project versions exist.");
	if (page.next_cursor) console.log(chalk.dim(`Next cursor: ${page.next_cursor}`));
}

export async function projectVersionPreviewCommand(version: string, options: ProjectOptions): Promise<void> {
	const preview = await createDirectoryWorkspaceVersionService(projectRoot(options)).previewVersion(version);
	if (options.json) return writeJson(preview);
	renderDirectoryVersionPreview(preview);
}

export async function projectVersionRestoreCommand(
	version: string,
	options: ProjectOptions & { yes?: boolean },
): Promise<void> {
	const service = createDirectoryWorkspaceVersionService(projectRoot(options));
	const preview = await service.previewVersion(version);
	if (!options.json) renderDirectoryVersionPreview(preview);
	if (!preview.can_restore)
		throw new UserError(preview.blockers[0] ?? preview.diagnostics[0]?.message ?? "Version cannot be restored.");
	if (!options.yes) {
		const confirmed = await prompts.confirm({
			message: "Restore this version to the project working directory?",
			output: process.stderr,
		});
		if (prompts.isCancel(confirmed) || !confirmed) return;
	}
	const restored = await service.restoreVersion(version, {
		headVersion: preview.base_head_version,
		projectRevision: preview.base_project_revision,
	});
	if (options.json) return writeJson(restored);
	log.success(
		`Restored ${version.slice(0, 12)} to the working directory. Version head and remote State were not changed.`,
	);
}

function renderDirectoryVersionPreview(
	preview: Awaited<ReturnType<DirectoryProjectVersionService["previewVersion"]>>,
): void {
	console.log(chalk.bold(`Version ${preview.version_id}`));
	for (const change of preview.changes) {
		const color = change.change === "create" ? chalk.green : change.change === "delete" ? chalk.red : chalk.yellow;
		console.log(color(`${change.change} ${change.path}${change.binary ? " (binary)" : ""}`));
		if (!change.binary) renderSimpleDiff(change.before ?? "", change.after ?? "");
	}
	renderDiagnostics(preview.diagnostics);
	for (const blocker of preview.blockers) console.log(chalk.yellow(`Blocker: ${blocker}`));
	console.log(`Can restore: ${preview.can_restore ? "yes" : "no"}`);
}

type DirectoryProjectVersionService = ReturnType<typeof createDirectoryWorkspaceVersionService>;

interface BuildSourcePreview {
	baselineVersion: string | null;
	projectRevision?: string;
	changes: Awaited<ReturnType<DirectoryProjectVersionService["previewVersion"]>>["changes"];
	error?: string;
}

async function loadBuildSourcePreview(projectRoot: string): Promise<BuildSourcePreview> {
	try {
		const service = createDirectoryWorkspaceVersionService(projectRoot);
		const status = await service.status();
		if (!status.head_version) return { baselineVersion: null, projectRevision: status.project_revision, changes: [] };
		const preview = await service.previewVersion(status.head_version);
		return {
			baselineVersion: status.head_version,
			projectRevision: preview.base_project_revision,
			changes: preview.changes,
		};
	} catch (error) {
		return {
			baselineVersion: null,
			changes: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function renderBuildSourcePreview(preview: BuildSourcePreview): void {
	console.log(chalk.bold("Project source changes"));
	if (preview.error) {
		console.log(chalk.yellow(` Source Diff unavailable: ${preview.error}`));
		return;
	}
	if (!preview.baselineVersion) {
		console.log(chalk.dim(" Source Diff unavailable: no project version baseline exists."));
		return;
	}
	console.log(chalk.dim(` baseline ${preview.baselineVersion.slice(0, 12)} -> working tree`));
	if (preview.changes.length === 0) {
		console.log(chalk.dim(" no source changes"));
		return;
	}
	for (const change of preview.changes) {
		const displayedChange = change.change === "create" ? "delete" : change.change === "delete" ? "create" : "update";
		const color = displayedChange === "create" ? chalk.green : displayedChange === "delete" ? chalk.red : chalk.yellow;
		console.log(color(`${displayedChange} ${change.path}${change.binary ? " (binary)" : ""}`));
		if (!change.binary) renderSimpleDiff(change.after ?? "", change.before ?? "");
	}
}

function renderSimpleDiff(before: string, after: string): void {
	if (before === after) {
		console.log(chalk.dim(" no content changes"));
		return;
	}
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	for (const line of beforeLines) if (!afterLines.includes(line)) console.log(chalk.red(`-${line}`));
	for (const line of afterLines) if (!beforeLines.includes(line)) console.log(chalk.green(`+${line}`));
}

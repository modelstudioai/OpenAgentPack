import { readFile } from "node:fs/promises";
import {
	createLocalGitVersionService,
	LocalGitError,
	type LocalProjectVersion,
	type LocalProjectVersionsPage,
	type LocalVersionPreview,
	type LocalVersionStatus,
	type PreparedAutomaticVersion,
} from "@openagentpack/local-git";
import { type ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";

export type ProjectGitStatus = LocalVersionStatus;
export type ProjectVersion = LocalProjectVersion;
export type ProjectVersionsPage = LocalProjectVersionsPage;
export type ProjectVersionPreview = Omit<LocalVersionPreview, "base_source_revision"> & {
	base_revision: string;
};
export interface AutomaticProjectVersionResult {
	version: ProjectVersion | null;
	git: ProjectGitStatus;
}

export class ProjectGitProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ProjectGitProtocolError";
	}
}

export async function getProjectGitStatus(
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectGitStatus> {
	await manager.ensureStarted();
	return withProjectGitErrors(() => serviceFor(manager).status());
}

export async function initializeProjectGit(
	input: { baseRevision: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectGitStatus> {
	return setProjectVersioning({ ...input, enabled: true, baselineMessage: "Initialize agents.yaml" }, manager);
}

export async function setProjectVersioning(
	input: { baseRevision: string; enabled: boolean; baselineMessage?: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectGitStatus> {
	const lease = projectMutationCoordinator.acquire(input.enabled ? "git_init" : "git_commit");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const status = input.enabled
			? (await withProjectGitErrors(() => service.enable(input.baselineMessage ?? "Enable automatic versions"))).git
			: await withProjectGitErrors(() => service.disable());
		await assertRevision(manager, input.baseRevision);
		return status;
	} finally {
		lease.release();
	}
}

export async function listProjectVersions(
	input: { cursor?: string; limit?: number } = {},
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionsPage> {
	return withProjectGitErrors(() => serviceFor(manager).listVersions(input));
}

export async function createProjectVersion(
	input: { baseRevision: string; baseHead: string | null; message: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<{ version: ProjectVersion; git: ProjectGitStatus }> {
	const lease = projectMutationCoordinator.acquire("git_commit");
	try {
		await assertRevision(manager, input.baseRevision);
		const source = await readFile(manager.configPath, "utf8");
		const result = await withProjectGitErrors(() =>
			serviceFor(manager).commitVersion({ source, message: input.message, baseHead: input.baseHead }),
		);
		await assertRevision(manager, input.baseRevision);
		return result;
	} finally {
		lease.release();
	}
}

export async function prepareProjectVersionForApply(
	input: { baseRevision: string; baselineMessage: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<PreparedAutomaticVersion | null> {
	await assertRevision(manager, input.baseRevision);
	const service = serviceFor(manager);
	let status = await withProjectGitErrors(() => service.status());
	if (!status.repository_root) {
		const lease = projectMutationCoordinator.acquire("git_init");
		try {
			await assertRevision(manager, input.baseRevision);
			status = (await withProjectGitErrors(() => service.enable(input.baselineMessage))).git;
		} finally {
			lease.release();
		}
	}
	if (!status.enabled) return null;
	const source = await readFile(manager.configPath, "utf8");
	await assertRevision(manager, input.baseRevision);
	return withProjectGitErrors(() => service.prepareAutomaticVersion(source));
}

export async function commitProjectVersionAfterApply(
	prepared: PreparedAutomaticVersion | null,
	message: string,
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<AutomaticProjectVersionResult> {
	const service = serviceFor(manager);
	if (!prepared) return { version: null, git: await withProjectGitErrors(() => service.status()) };
	const version = await withProjectGitErrors(() => service.commitAutomaticVersion(prepared, message));
	return { version, git: await withProjectGitErrors(() => service.status()) };
}

/** Compatibility helper for non-route callers that explicitly request an immediate version. */
export async function ensureProjectVersionForApply(
	input: { baseRevision: string; message: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<AutomaticProjectVersionResult> {
	const lease = projectMutationCoordinator.acquire("git_commit");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const initialStatus = await withProjectGitErrors(() => service.status());
		if (!initialStatus.repository_root) {
			return withProjectGitErrors(() => service.enable(input.message));
		}
		if (!initialStatus.enabled) return { version: null, git: initialStatus };
		const source = await readFile(manager.configPath, "utf8");
		const prepared = await withProjectGitErrors(() => service.prepareAutomaticVersion(source));
		if (!prepared) return { version: null, git: initialStatus };
		const version = await withProjectGitErrors(() => service.commitAutomaticVersion(prepared, input.message));
		return { version, git: await withProjectGitErrors(() => service.status()) };
	} finally {
		lease.release();
	}
}

export async function previewProjectVersion(
	input: { commit: string; baseRevision: string; baseHead: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionPreview> {
	await assertRevision(manager, input.baseRevision);
	const status = await withProjectGitErrors(() => serviceFor(manager).status());
	assertBaseHead(input.baseHead, status.head);
	const preview = await withProjectGitErrors(() => serviceFor(manager).previewVersion(input.commit));
	await assertRevision(manager, input.baseRevision);
	return toProjectPreview(preview, input.baseRevision);
}

export async function restoreProjectVersion(
	input: { commit: string; baseRevision: string; baseHead: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionPreview & { new_revision: string }> {
	const lease = projectMutationCoordinator.acquire("version_restore");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const preview = await withProjectGitErrors(() => service.previewVersion(input.commit));
		assertBaseHead(input.baseHead, preview.base_head);
		if (!preview.can_restore) {
			const message =
				preview.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
				preview.blockers[0] ??
				"This version cannot be restored.";
			throw new ProjectGitProtocolError(message, 422);
		}
		await withProjectGitErrors(() =>
			service.restoreVersion(input.commit, {
				head: input.baseHead,
				sourceRevision: preview.base_source_revision,
			}),
		);
		const newRevision = await manager.refreshAfterSourceMutation();
		if (!newRevision) throw new ProjectGitProtocolError("The restored project has no revision.", 500);
		return { ...toProjectPreview(preview, input.baseRevision), new_revision: newRevision };
	} finally {
		lease.release();
	}
}

function serviceFor(manager: ProjectRuntimeManager) {
	return createLocalGitVersionService({ configPath: manager.configPath });
}

function toProjectPreview(preview: LocalVersionPreview, baseRevision: string): ProjectVersionPreview {
	const { base_source_revision: _baseSourceRevision, ...wirePreview } = preview;
	return { ...wirePreview, base_revision: baseRevision };
}

async function assertRevision(manager: ProjectRuntimeManager, expected: string): Promise<void> {
	const current = await manager.computeCurrentSourceRevision();
	if (current !== expected) {
		throw new ProjectGitProtocolError("Project configuration changed. Reload before changing versions.", 409);
	}
}

function assertBaseHead(expected: string | null, current: string | null): void {
	if (expected !== current) throw new ProjectGitProtocolError("Git HEAD changed. Reload versions and retry.", 409);
}

async function withProjectGitErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof ProjectGitProtocolError) throw error;
		if (error instanceof LocalGitError) {
			throw new ProjectGitProtocolError(error.message, statusForLocalGitError(error));
		}
		throw error;
	}
}

function statusForLocalGitError(error: LocalGitError): number {
	if (/full hexadecimal|message must be|cursor is invalid/i.test(error.message)) return 400;
	if (/not found|not reachable|no versions|does not exist in this version/i.test(error.message)) return 404;
	if (/changed|detached head|staged|conflict|operation is in progress|no changes|disabled/i.test(error.message)) {
		return 409;
	}
	return 422;
}

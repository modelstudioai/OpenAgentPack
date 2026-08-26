import { readFile } from "node:fs/promises";
import {
	createProjectVersionService,
	type PreparedProjectVersion,
	type ProjectVersion,
	ProjectVersionError,
	type ProjectVersionPreview,
	type ProjectVersionStatus,
	type ProjectVersionsPage,
} from "@openagentpack/project-versions";
import { type ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";

export type ProjectVersioningStatus = ProjectVersionStatus;
export type ProjectVersionEntry = ProjectVersion;
export type ProjectVersionHistoryPage = ProjectVersionsPage;
export type WorkbenchVersionPreview = Omit<ProjectVersionPreview, "base_source_revision"> & {
	base_revision: string;
};

export interface AutomaticProjectVersionResult {
	version: ProjectVersion | null;
	versioning: ProjectVersionStatus;
}

export class ProjectVersionProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ProjectVersionProtocolError";
	}
}

export async function getProjectVersioningStatus(
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionStatus> {
	await manager.ensureStarted();
	return withProjectVersionErrors(() => serviceFor(manager).status());
}

export async function setProjectVersioning(
	input: { baseRevision: string; enabled: boolean; baselineMessage?: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionStatus> {
	const lease = projectMutationCoordinator.acquire("version_enable");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const status = input.enabled
			? (await withProjectVersionErrors(() => service.enable(input.baselineMessage ?? "Enable local versions")))
					.versioning
			: await withProjectVersionErrors(() => service.disable());
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
	return withProjectVersionErrors(() => serviceFor(manager).listVersions(input));
}

export async function prepareProjectVersionForApply(
	input: { baseRevision: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<PreparedProjectVersion | null> {
	await assertRevision(manager, input.baseRevision);
	const service = serviceFor(manager);
	const status = await withProjectVersionErrors(() => service.status());
	if (!status.enabled) return null;
	const source = await readFile(manager.configPath, "utf8");
	await assertRevision(manager, input.baseRevision);
	return withProjectVersionErrors(() => service.prepareVersion(source));
}

export async function commitProjectVersionAfterApply(
	prepared: PreparedProjectVersion | null,
	message: string,
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<AutomaticProjectVersionResult> {
	const service = serviceFor(manager);
	if (!prepared) {
		return { version: null, versioning: await withProjectVersionErrors(() => service.status()) };
	}
	const version = await withProjectVersionErrors(() => service.commitPrepared(prepared, message));
	return { version, versioning: await withProjectVersionErrors(() => service.status()) };
}

export async function releaseProjectVersionAfterApply(
	prepared: PreparedProjectVersion | null,
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<void> {
	await withProjectVersionErrors(() => serviceFor(manager).releasePrepared(prepared));
}

export async function previewProjectVersion(
	input: { versionId: string; baseRevision: string; baseHeadVersion: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<WorkbenchVersionPreview> {
	await assertRevision(manager, input.baseRevision);
	const status = await withProjectVersionErrors(() => serviceFor(manager).status());
	assertHeadVersion(input.baseHeadVersion, status.head_version);
	const preview = await withProjectVersionErrors(() => serviceFor(manager).previewVersion(input.versionId));
	await assertRevision(manager, input.baseRevision);
	return toWorkbenchPreview(preview, input.baseRevision);
}

export async function restoreProjectVersion(
	input: { versionId: string; baseRevision: string; baseHeadVersion: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<WorkbenchVersionPreview & { new_revision: string }> {
	const lease = projectMutationCoordinator.acquire("version_restore");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const preview = await withProjectVersionErrors(() => service.previewVersion(input.versionId));
		assertHeadVersion(input.baseHeadVersion, preview.base_head_version);
		if (!preview.can_restore) {
			const message =
				preview.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
				preview.blockers[0] ??
				"This version cannot be restored.";
			throw new ProjectVersionProtocolError(message, 422);
		}
		await withProjectVersionErrors(() =>
			service.restoreVersion(input.versionId, {
				headVersion: input.baseHeadVersion,
				sourceRevision: preview.base_source_revision,
			}),
		);
		const newRevision = await manager.refreshAfterSourceMutation();
		if (!newRevision) throw new ProjectVersionProtocolError("The restored project has no revision.", 500);
		return { ...toWorkbenchPreview(preview, input.baseRevision), new_revision: newRevision };
	} finally {
		lease.release();
	}
}

function serviceFor(manager: ProjectRuntimeManager) {
	return createProjectVersionService({ configPath: manager.configPath });
}

function toWorkbenchPreview(preview: ProjectVersionPreview, baseRevision: string): WorkbenchVersionPreview {
	const { base_source_revision: _baseSourceRevision, ...wirePreview } = preview;
	return { ...wirePreview, base_revision: baseRevision };
}

async function assertRevision(manager: ProjectRuntimeManager, expected: string): Promise<void> {
	const current = await manager.computeCurrentSourceRevision();
	if (current !== expected) {
		throw new ProjectVersionProtocolError("Project configuration changed. Reload before changing versions.", 409);
	}
}

function assertHeadVersion(expected: string | null, current: string | null): void {
	if (expected !== current) {
		throw new ProjectVersionProtocolError("The current local version changed. Reload versions and retry.", 409);
	}
}

async function withProjectVersionErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof ProjectVersionProtocolError) throw error;
		if (error instanceof ProjectVersionError) {
			throw new ProjectVersionProtocolError(error.message, statusForProjectVersionError(error));
		}
		throw error;
	}
}

function statusForProjectVersionError(error: ProjectVersionError): number {
	if (/64-character|message must be|cursor is invalid/i.test(error.message)) return 400;
	if (/not found|no versions|blob.*missing/i.test(error.message)) return 404;
	if (/changed|disabled|another process|mutation lease/i.test(error.message)) return 409;
	return 422;
}

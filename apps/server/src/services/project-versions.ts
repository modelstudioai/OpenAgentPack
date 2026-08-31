import type {
	DirectoryProjectVersion,
	DirectoryProjectVersionPreview,
	DirectoryProjectVersionStatus,
	DirectoryVersionFileChange,
	PreparedDirectoryProjectVersion,
} from "@openagentpack/project-versions";
import { createDirectoryWorkspaceVersionService, inspectDirectoryProject } from "@openagentpack/project-workspace";
import { type ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";

export interface ProjectVersioningStatus {
	initialized: boolean;
	enabled: boolean;
	store_root: string;
	config_path: string;
	head_version: string | null;
	source_status: "clean" | "modified" | "unversioned";
	source_versioned: boolean;
	write_blockers: string[];
	restore_blockers: string[];
}

export interface ProjectVersionEntry {
	version_id: string;
	short_version: string;
	parent_version: string | null;
	source_hash: string;
	message: string;
	created_by: string;
	created_at: string;
}

export interface ProjectVersionHistoryPage {
	versions: ProjectVersionEntry[];
	next_cursor: string | null;
}

export interface WorkbenchVersionPreview {
	version_id: string;
	base_revision: string;
	base_head_version: string;
	before_yaml: string;
	after_yaml: string;
	changes: DirectoryVersionFileChange[];
	diagnostics: DirectoryProjectVersionPreview["diagnostics"];
	can_restore: boolean;
	blockers: string[];
}

export interface AutomaticProjectVersionResult {
	version: ProjectVersionEntry | null;
	versioning: ProjectVersioningStatus;
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
): Promise<ProjectVersioningStatus> {
	await manager.ensureStarted();
	return statusForWire(await serviceFor(manager).status(), manager);
}

export async function setProjectVersioning(
	input: { baseRevision: string; enabled: boolean; baselineMessage?: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersioningStatus> {
	const lease = projectMutationCoordinator.acquire("version_enable");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const status = input.enabled
			? (await service.enable(input.baselineMessage ?? "Enable project versions")).versioning
			: await service.disable();
		return statusForWire(status, manager);
	} finally {
		lease.release();
	}
}

export async function listProjectVersions(
	input: { cursor?: string; limit?: number } = {},
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<ProjectVersionHistoryPage> {
	const page = await serviceFor(manager).listVersions(input);
	return { versions: page.versions.map(versionForWire), next_cursor: page.next_cursor };
}

export async function prepareProjectVersionForApply(
	input: { baseRevision: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<PreparedDirectoryProjectVersion> {
	await assertRevision(manager, input.baseRevision);
	const service = serviceFor(manager);
	const inspection = await inspectDirectoryProject(manager.projectRoot);
	if (inspection.project_revision !== input.baseRevision) {
		throw new ProjectVersionProtocolError("Project changed before Publish.", 409);
	}
	return service.prepareVersion({
		project_revision: inspection.project_revision,
		canonical_yaml: inspection.canonical_yaml,
		files: inspection.source_files,
	});
}

export async function commitProjectVersionAfterApply(
	prepared: PreparedDirectoryProjectVersion | null,
	message: string,
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<AutomaticProjectVersionResult> {
	const service = serviceFor(manager);
	const version = prepared ? await service.commitPrepared(prepared, message) : null;
	return {
		version: version ? versionForWire(version) : null,
		versioning: statusForWire(await service.status(), manager),
	};
}

export async function releaseProjectVersionAfterApply(
	prepared: PreparedDirectoryProjectVersion | null,
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<void> {
	await serviceFor(manager).releasePrepared(prepared);
}

export async function previewProjectVersion(
	input: { versionId: string; baseRevision: string; baseHeadVersion: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<WorkbenchVersionPreview> {
	await assertRevision(manager, input.baseRevision);
	const status = await serviceFor(manager).status();
	assertHeadVersion(input.baseHeadVersion, status.head_version);
	const preview = await serviceFor(manager).previewVersion(input.versionId);
	await assertRevision(manager, input.baseRevision);
	return previewForWire(preview, input.baseRevision);
}

export async function restoreProjectVersion(
	input: { versionId: string; baseRevision: string; baseHeadVersion: string },
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<WorkbenchVersionPreview & { new_revision: string }> {
	const lease = projectMutationCoordinator.acquire("version_restore");
	try {
		await assertRevision(manager, input.baseRevision);
		const service = serviceFor(manager);
		const preview = await service.previewVersion(input.versionId);
		assertHeadVersion(input.baseHeadVersion, preview.base_head_version);
		if (!preview.can_restore) {
			throw new ProjectVersionProtocolError(
				preview.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
					preview.blockers[0] ??
					"Version cannot be restored.",
				422,
			);
		}
		await service.restoreVersion(input.versionId, {
			headVersion: input.baseHeadVersion,
			projectRevision: preview.base_project_revision,
		});
		const newRevision = await manager.refreshAfterSourceMutation();
		if (!newRevision) throw new ProjectVersionProtocolError("The restored project has no revision.", 500);
		return { ...previewForWire(preview, input.baseRevision), new_revision: newRevision };
	} finally {
		lease.release();
	}
}

function serviceFor(manager: ProjectRuntimeManager) {
	return createDirectoryWorkspaceVersionService(manager.projectRoot);
}

function statusForWire(status: DirectoryProjectVersionStatus, manager: ProjectRuntimeManager): ProjectVersioningStatus {
	return {
		initialized: status.initialized,
		enabled: status.enabled,
		store_root: status.store_root,
		config_path: manager.projectRoot,
		head_version: status.head_version,
		source_status: status.source_status,
		source_versioned: status.source_status === "clean",
		write_blockers: status.write_blockers,
		restore_blockers: status.restore_blockers,
	};
}

function versionForWire(version: DirectoryProjectVersion): ProjectVersionEntry {
	return {
		version_id: version.version_id,
		short_version: version.short_version,
		parent_version: version.parent_version,
		source_hash: version.tree_hash,
		message: version.message,
		created_by: version.created_by,
		created_at: version.created_at,
	};
}

function previewForWire(preview: DirectoryProjectVersionPreview, baseRevision: string): WorkbenchVersionPreview {
	return {
		version_id: preview.version_id,
		base_revision: baseRevision,
		base_head_version: preview.base_head_version,
		before_yaml: preview.before_yaml,
		after_yaml: preview.after_yaml,
		changes: preview.changes,
		diagnostics: preview.diagnostics,
		can_restore: preview.can_restore,
		blockers: preview.blockers,
	};
}

async function assertRevision(manager: ProjectRuntimeManager, expected: string): Promise<void> {
	if ((await manager.computeCurrentSourceRevision()) !== expected) {
		throw new ProjectVersionProtocolError("Project files changed. Reload before changing versions.", 409);
	}
}

function assertHeadVersion(expected: string | null, current: string | null): void {
	if (expected !== current) {
		throw new ProjectVersionProtocolError("The current local version changed. Reload and retry.", 409);
	}
}

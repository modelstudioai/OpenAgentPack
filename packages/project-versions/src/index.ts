import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { type Diagnostic, inspectProjectSource, UserError as SdkUserError } from "@openagentpack/sdk";

const STORE_SCHEMA_VERSION = 1;
const SELF_IGNORE_SOURCE = "*\n";

export type ProjectVersionErrorCode =
	| "store_missing"
	| "store_blocked"
	| "stale_snapshot"
	| "invalid_version"
	| "invalid_source"
	| "storage_failed";

export class ProjectVersionError extends SdkUserError {
	constructor(
		message: string,
		readonly code: ProjectVersionErrorCode = "storage_failed",
	) {
		super(message);
		this.name = "ProjectVersionError";
	}
}

const UserError = ProjectVersionError;

export type ProjectSourceStatus = "clean" | "modified" | "unversioned";

export interface ProjectVersionStatus {
	initialized: boolean;
	enabled: boolean;
	store_root: string;
	config_path: string;
	head_version: string | null;
	source_status: ProjectSourceStatus;
	source_versioned: boolean;
	write_blockers: string[];
	restore_blockers: string[];
}

export interface ProjectVersion {
	version_id: string;
	short_version: string;
	parent_version: string | null;
	source_hash: string;
	message: string;
	created_by: string;
	created_at: string;
}

export interface ProjectVersionsPage {
	versions: ProjectVersion[];
	next_cursor: string | null;
}

export interface ProjectVersionPreview {
	version_id: string;
	base_head_version: string;
	base_source_revision: string;
	before_yaml: string;
	after_yaml: string;
	diagnostics: Diagnostic[];
	can_restore: boolean;
	blockers: string[];
}

export interface PreparedProjectVersion {
	configPath: string;
	storeRoot: string;
	baseHeadVersion: string;
	source: string;
	sourceRevision: string;
	needsVersion: boolean;
	leaseToken: string;
}

interface StoredProjectVersion extends ProjectVersion {
	nonce: string;
}

interface VersionStore {
	schema_version: typeof STORE_SCHEMA_VERSION;
	config_path: string;
	enabled: boolean;
	head_version: string | null;
}

interface StoreContext {
	configPath: string;
	storeRoot: string;
	storePath: string;
	entriesRoot: string;
	blobsRoot: string;
	ignorePath: string;
	lockPath: string;
	leasePath: string;
	configRelativePath: string;
}

interface MutationLease {
	pid: number;
	token: string;
	kind: string;
	created_at: string;
}

export async function readProjectVersionSource(configFile: string): Promise<{ configPath: string; source: string }> {
	const configPath = await resolveConfigPath(configFile);
	return { configPath, source: await readFile(configPath, "utf8") };
}

export async function getProjectVersionStatus(configFile: string): Promise<ProjectVersionStatus> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const store = await readStore(context, false);
	if (!store) return absentStatus(context);
	const [source, blocker] = await Promise.all([readFile(configPath, "utf8"), mutationBlocker(context)]);
	return publicStatus(context, store, source, blocker ? [blocker] : []);
}

export async function enableProjectVersioning(
	configFile: string,
	message = "Enable OpenAgentPack versioning",
): Promise<{ version: ProjectVersion | null; versioning: ProjectVersionStatus }> {
	const { configPath, source } = await readProjectVersionSource(configFile);
	await assertValidVersionSource(source, configPath);
	const context = storeContext(configPath);
	const lease = await acquireMutationLease(context, "version_enable");
	try {
		const store = (await readStore(context, false)) ?? emptyStore(context);
		const head = await readHeadVersion(context, store);
		store.enabled = true;
		const version =
			head?.source_hash === sourceRevision(source) ? null : await appendVersion(context, store, source, message);
		if (!version) await writeStore(context, store);
		return { version, versioning: await publicStatus(context, store, source) };
	} finally {
		await releaseMutationLease(context, lease.token);
	}
}

export async function disableProjectVersioning(configFile: string): Promise<ProjectVersionStatus> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const existing = await readStore(context, false);
	if (!existing) return absentStatus(context);
	const lease = await acquireMutationLease(context, "version_disable");
	try {
		const store = await requireStore(context);
		store.enabled = false;
		await writeStore(context, store);
		return await publicStatus(context, store, await readFile(configPath, "utf8"));
	} finally {
		await releaseMutationLease(context, lease.token);
	}
}

export async function listProjectVersions(
	configFile: string,
	input: { cursor?: string; limit?: number } = {},
): Promise<ProjectVersionsPage> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const store = await requireStore(context);
	const { offset, headVersion } = parseCursor(input.cursor, store.head_version);
	if (headVersion !== store.head_version) {
		throw new UserError("Version history changed. Restart pagination from the first page.", "stale_snapshot");
	}
	const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
	const versions = await readVersionChain(context, store.head_version);
	return {
		versions: versions.slice(offset, offset + limit).map(publicVersion),
		next_cursor:
			offset + limit < versions.length
				? encodeCursor({ headVersion: store.head_version, offset: offset + limit })
				: null,
	};
}

export async function previewProjectVersion(configFile: string, versionId: string): Promise<ProjectVersionPreview> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const store = await requireStore(context);
	if (!store.head_version) throw new UserError("The local version store has no versions.", "invalid_version");
	const selected = await requireReachableVersion(context, store.head_version, versionId);
	const [currentSource, historicalSource, blocker] = await Promise.all([
		readFile(configPath, "utf8"),
		readBlob(context, selected),
		mutationBlocker(context),
	]);
	const [currentInspection, historicalInspection] = await Promise.all([
		inspectProjectSource(currentSource, configPath),
		inspectProjectSource(historicalSource, configPath),
	]);
	const blockers = blocker ? [blocker] : [];
	return {
		version_id: selected.version_id,
		base_head_version: store.head_version,
		base_source_revision: sourceRevision(currentSource),
		before_yaml: currentInspection.redacted_source,
		after_yaml: historicalInspection.redacted_source,
		diagnostics: historicalInspection.diagnostics,
		can_restore:
			historicalInspection.diagnostics.every((diagnostic) => diagnostic.severity !== "error") && blockers.length === 0,
		blockers,
	};
}

export async function restoreProjectVersion(
	configFile: string,
	versionId: string,
	base: { headVersion: string; sourceRevision: string },
): Promise<ProjectVersionPreview> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const lease = await acquireMutationLease(context, "version_restore");
	try {
		const store = await requireStore(context);
		assertHeadVersion(base.headVersion, store.head_version);
		const selected = await requireReachableVersion(context, base.headVersion, versionId);
		const currentSource = await readFile(configPath, "utf8");
		assertSourceRevision(base.sourceRevision, currentSource);
		const historicalSource = await readBlob(context, selected);
		const [currentInspection, historicalInspection] = await Promise.all([
			inspectProjectSource(currentSource, configPath),
			inspectProjectSource(historicalSource, configPath),
		]);
		const validationError = historicalInspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
		if (validationError) throw new UserError(validationError.message, "invalid_source");
		await atomicWriteConfig(configPath, historicalSource, base.sourceRevision);
		return {
			version_id: selected.version_id,
			base_head_version: base.headVersion,
			base_source_revision: base.sourceRevision,
			before_yaml: currentInspection.redacted_source,
			after_yaml: historicalInspection.redacted_source,
			diagnostics: historicalInspection.diagnostics,
			can_restore: true,
			blockers: [],
		};
	} finally {
		await releaseMutationLease(context, lease.token);
	}
}

export async function prepareProjectVersion(
	configFile: string,
	expectedSource: string,
): Promise<PreparedProjectVersion | null> {
	const configPath = await resolveConfigPath(configFile);
	const context = storeContext(configPath);
	const initialStore = await readStore(context, false);
	if (!initialStore?.enabled) return null;
	const lease = await acquireMutationLease(context, "apply");
	try {
		const store = await requireStore(context);
		if (!store.enabled || !store.head_version) {
			throw new UserError("Automatic versioning changed while Apply was starting.", "stale_snapshot");
		}
		const source = await readFile(configPath, "utf8");
		if (source !== expectedSource) {
			throw new UserError(
				"agents.yaml changed while Apply was being planned. Rerun Apply with the current file.",
				"stale_snapshot",
			);
		}
		await assertValidVersionSource(source, configPath);
		const head = await readEntry(context, store.head_version);
		return {
			configPath,
			storeRoot: context.storeRoot,
			baseHeadVersion: store.head_version,
			source,
			sourceRevision: sourceRevision(source),
			needsVersion: head.source_hash !== sourceRevision(source),
			leaseToken: lease.token,
		};
	} catch (error) {
		await releaseMutationLease(context, lease.token);
		throw error;
	}
}

export async function commitPreparedProjectVersion(
	prepared: PreparedProjectVersion,
	message = "Apply agents.yaml",
): Promise<ProjectVersion | null> {
	const context = storeContext(prepared.configPath);
	if (context.storeRoot !== prepared.storeRoot) {
		throw postApplyVersionError("the local version store location changed");
	}
	try {
		await assertMutationLease(context, prepared.leaseToken);
		const currentSource = await readFile(prepared.configPath, "utf8");
		if (currentSource !== prepared.source || sourceRevision(currentSource) !== prepared.sourceRevision) {
			throw new UserError("agents.yaml changed while Apply was running", "stale_snapshot");
		}
		const store = await requireStore(context);
		if (!store.enabled) {
			throw new UserError("automatic versioning was disabled while Apply was running", "stale_snapshot");
		}
		assertHeadVersion(prepared.baseHeadVersion, store.head_version);
		const head = await readEntry(context, prepared.baseHeadVersion);
		if (!prepared.needsVersion && head.source_hash === prepared.sourceRevision) return null;
		return await appendVersion(context, store, prepared.source, message);
	} catch (error) {
		if (error instanceof ProjectVersionError && error.message.startsWith("Remote Apply completed")) throw error;
		throw postApplyVersionError(errorMessage(error));
	} finally {
		await releaseMutationLease(context, prepared.leaseToken).catch(() => undefined);
	}
}

export async function releasePreparedProjectVersion(prepared: PreparedProjectVersion | null): Promise<void> {
	if (!prepared) return;
	await releaseMutationLease(storeContext(prepared.configPath), prepared.leaseToken);
}

export interface ProjectVersionService {
	readSource(): Promise<{ configPath: string; source: string }>;
	status(): Promise<ProjectVersionStatus>;
	enable(message?: string): Promise<{ version: ProjectVersion | null; versioning: ProjectVersionStatus }>;
	disable(): Promise<ProjectVersionStatus>;
	listVersions(input?: { cursor?: string; limit?: number }): Promise<ProjectVersionsPage>;
	previewVersion(versionId: string): Promise<ProjectVersionPreview>;
	restoreVersion(
		versionId: string,
		base: { headVersion: string; sourceRevision: string },
	): Promise<ProjectVersionPreview>;
	prepareVersion(expectedSource: string): Promise<PreparedProjectVersion | null>;
	commitPrepared(prepared: PreparedProjectVersion, message?: string): Promise<ProjectVersion | null>;
	releasePrepared(prepared: PreparedProjectVersion | null): Promise<void>;
}

export function createProjectVersionService(input: { configPath: string }): ProjectVersionService {
	const configPath = input.configPath;
	return {
		readSource: () => readProjectVersionSource(configPath),
		status: () => getProjectVersionStatus(configPath),
		enable: (message) => enableProjectVersioning(configPath, message),
		disable: () => disableProjectVersioning(configPath),
		listVersions: (options) => listProjectVersions(configPath, options),
		previewVersion: (versionId) => previewProjectVersion(configPath, versionId),
		restoreVersion: (versionId, base) => restoreProjectVersion(configPath, versionId, base),
		prepareVersion: (expectedSource) => prepareProjectVersion(configPath, expectedSource),
		commitPrepared: (prepared, message) => commitPreparedProjectVersion(prepared, message),
		releasePrepared: (prepared) => releasePreparedProjectVersion(prepared),
	};
}

async function appendVersion(
	context: StoreContext,
	store: VersionStore,
	source: string,
	message: string,
): Promise<ProjectVersion> {
	assertVersionMessage(message);
	const sourceHash = sourceRevision(source);
	await writeBlob(context, sourceHash, source);
	const entryWithoutId = {
		parent_version: store.head_version,
		source_hash: sourceHash,
		message,
		created_by: localAuthorName(),
		created_at: new Date().toISOString(),
		nonce: randomUUID(),
	};
	const versionId = createHash("sha256").update(JSON.stringify(entryWithoutId)).digest("hex");
	const version: StoredProjectVersion = {
		version_id: versionId,
		short_version: versionId.slice(0, 12),
		...entryWithoutId,
	};
	await writeEntry(context, version);
	store.head_version = version.version_id;
	await writeStore(context, store);
	return publicVersion(version);
}

function publicVersion(version: StoredProjectVersion): ProjectVersion {
	const { nonce: _nonce, ...publicEntry } = version;
	return publicEntry;
}

function storeContext(configPath: string): StoreContext {
	const storeRoot = resolve(dirname(configPath), ".openagentpack", "versions");
	return {
		configPath,
		storeRoot,
		storePath: resolve(storeRoot, "store.json"),
		entriesRoot: resolve(storeRoot, "entries"),
		blobsRoot: resolve(storeRoot, "blobs"),
		ignorePath: resolve(storeRoot, ".gitignore"),
		lockPath: resolve(storeRoot, "mutation.lock"),
		leasePath: resolve(storeRoot, "mutation.lock", "lease.json"),
		configRelativePath: relative(dirname(configPath), configPath) || basename(configPath),
	};
}

function emptyStore(context: StoreContext): VersionStore {
	return {
		schema_version: STORE_SCHEMA_VERSION,
		config_path: context.configRelativePath,
		enabled: false,
		head_version: null,
	};
}

async function readStore(context: StoreContext, required: boolean): Promise<VersionStore | null> {
	let source: string;
	try {
		source = await readFile(context.storePath, "utf8");
	} catch (error) {
		if (isFileSystemError(error, "ENOENT") && !required) return null;
		if (isFileSystemError(error, "ENOENT")) {
			throw new UserError(
				"No local version store exists for agents.yaml. Enable local versions first.",
				"store_missing",
			);
		}
		throw new UserError(`Cannot read the local version store: ${errorMessage(error)}`, "storage_failed");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new UserError("The local version store is not valid JSON.", "storage_failed");
	}
	return parseStore(parsed, context);
}

async function requireStore(context: StoreContext): Promise<VersionStore> {
	return (await readStore(context, true))!;
}

function parseStore(value: unknown, context: StoreContext): VersionStore {
	if (!isRecord(value) || value.schema_version !== STORE_SCHEMA_VERSION) {
		throw new UserError("The local version store uses an unsupported schema.", "storage_failed");
	}
	if (value.config_path !== context.configRelativePath || typeof value.enabled !== "boolean") {
		throw new UserError("The local version store does not belong to this agents.yaml.", "storage_failed");
	}
	if (value.head_version !== null && !isVersionId(value.head_version)) {
		throw new UserError("The local version store has an invalid head version.", "storage_failed");
	}
	return {
		schema_version: STORE_SCHEMA_VERSION,
		config_path: value.config_path,
		enabled: value.enabled,
		head_version: value.head_version,
	};
}

async function readHeadVersion(context: StoreContext, store: VersionStore): Promise<StoredProjectVersion | null> {
	return store.head_version ? readEntry(context, store.head_version) : null;
}

async function readVersionChain(context: StoreContext, headVersion: string | null): Promise<StoredProjectVersion[]> {
	const versions: StoredProjectVersion[] = [];
	const seen = new Set<string>();
	let currentVersion = headVersion;
	while (currentVersion) {
		if (seen.has(currentVersion)) {
			throw new UserError("The local version history contains a cycle.", "storage_failed");
		}
		seen.add(currentVersion);
		const entry = await readEntry(context, currentVersion);
		versions.push(entry);
		currentVersion = entry.parent_version;
	}
	return versions;
}

async function requireReachableVersion(
	context: StoreContext,
	headVersion: string,
	versionId: string,
): Promise<StoredProjectVersion> {
	assertVersionId(versionId);
	const versions = await readVersionChain(context, headVersion);
	const selected = versions.find((entry) => entry.version_id === versionId);
	if (!selected) throw new UserError("Local version was not found in the current history.", "invalid_version");
	return selected;
}

async function readEntry(context: StoreContext, versionId: string): Promise<StoredProjectVersion> {
	assertVersionId(versionId);
	let source: string;
	try {
		source = await readFile(resolve(context.entriesRoot, `${versionId}.json`), "utf8");
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) {
			throw new UserError("A version entry in the local history is missing.", "storage_failed");
		}
		throw new UserError(`Cannot read a version entry: ${errorMessage(error)}`, "storage_failed");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new UserError("A local version entry is not valid JSON.", "storage_failed");
	}
	return parseEntry(parsed, versionId);
}

function parseEntry(value: unknown, expectedVersionId: string): StoredProjectVersion {
	if (
		!isRecord(value) ||
		value.version_id !== expectedVersionId ||
		value.short_version !== expectedVersionId.slice(0, 12) ||
		(value.parent_version !== null && !isVersionId(value.parent_version)) ||
		!isVersionId(value.source_hash) ||
		typeof value.message !== "string" ||
		typeof value.created_by !== "string" ||
		typeof value.created_at !== "string" ||
		typeof value.nonce !== "string"
	) {
		throw new UserError("The local version history contains an invalid entry.", "storage_failed");
	}
	const identity = {
		parent_version: value.parent_version,
		source_hash: value.source_hash,
		message: value.message,
		created_by: value.created_by,
		created_at: value.created_at,
		nonce: value.nonce,
	};
	if (createHash("sha256").update(JSON.stringify(identity)).digest("hex") !== expectedVersionId) {
		throw new UserError("A local version entry failed its identity check.", "storage_failed");
	}
	return {
		version_id: expectedVersionId,
		short_version: expectedVersionId.slice(0, 12),
		...identity,
	};
}

async function writeStore(context: StoreContext, store: VersionStore): Promise<void> {
	await ensureStoreLayout(context);
	await atomicWrite(context.storePath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

async function writeEntry(context: StoreContext, version: StoredProjectVersion): Promise<void> {
	await ensureStoreLayout(context);
	await writeImmutable(
		resolve(context.entriesRoot, `${version.version_id}.json`),
		`${JSON.stringify(version, null, 2)}\n`,
	);
}

async function writeBlob(context: StoreContext, sourceHash: string, source: string): Promise<void> {
	await ensureStoreLayout(context);
	await writeImmutable(resolve(context.blobsRoot, `${sourceHash}.yaml`), source);
}

async function readBlob(context: StoreContext, version: StoredProjectVersion): Promise<string> {
	let source: string;
	try {
		source = await readFile(resolve(context.blobsRoot, `${version.source_hash}.yaml`), "utf8");
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) {
			throw new UserError("The YAML blob for this version is missing.", "invalid_version");
		}
		throw new UserError(`Cannot read the YAML blob: ${errorMessage(error)}`, "storage_failed");
	}
	if (sourceRevision(source) !== version.source_hash) {
		throw new UserError("The YAML blob for this version failed its content hash check.", "invalid_version");
	}
	return source;
}

async function ensureStoreLayout(context: StoreContext): Promise<void> {
	await mkdir(context.entriesRoot, { recursive: true, mode: 0o700 });
	await mkdir(context.blobsRoot, { recursive: true, mode: 0o700 });
	try {
		await access(context.ignorePath, constants.F_OK);
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) throw error;
		await writeImmutable(context.ignorePath, SELF_IGNORE_SOURCE);
	}
}

async function writeImmutable(path: string, source: string): Promise<void> {
	try {
		const existing = await readFile(path, "utf8");
		if (existing !== source) {
			throw new UserError("An immutable local version object has conflicting content.", "storage_failed");
		}
		return;
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) throw error;
	}
	await atomicWrite(path, source, 0o600);
}

async function acquireMutationLease(context: StoreContext, kind: string): Promise<MutationLease> {
	await ensureStoreLayout(context);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await mkdir(context.lockPath, { mode: 0o700 });
			const lease: MutationLease = {
				pid: process.pid,
				token: randomUUID(),
				kind,
				created_at: new Date().toISOString(),
			};
			await atomicWrite(context.leasePath, `${JSON.stringify(lease, null, 2)}\n`, 0o600);
			return lease;
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) {
				throw new UserError(`Cannot lock the local version store: ${errorMessage(error)}`, "storage_failed");
			}
			if (await recoverDeadLease(context)) continue;
			throw new UserError(lockBlocker(context), "store_blocked");
		}
	}
	throw new UserError(lockBlocker(context), "store_blocked");
}

async function assertMutationLease(context: StoreContext, token: string): Promise<void> {
	const lease = await readMutationLease(context);
	if (!lease || lease.token !== token || lease.pid !== process.pid) {
		throw new UserError("The local version mutation lease changed while Apply was running.", "stale_snapshot");
	}
}

async function releaseMutationLease(context: StoreContext, token: string): Promise<void> {
	const lease = await readMutationLease(context);
	if (!lease) return;
	if (lease.token !== token || lease.pid !== process.pid) {
		throw new UserError("Refusing to release a local version lease owned by another process.", "store_blocked");
	}
	await unlink(context.leasePath);
	await rmdir(context.lockPath);
	await syncDirectory(context.storeRoot);
}

async function readMutationLease(context: StoreContext): Promise<MutationLease | null> {
	let source: string;
	try {
		source = await readFile(context.leasePath, "utf8");
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return null;
		throw new UserError(`Cannot read the local version lease: ${errorMessage(error)}`, "storage_failed");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return null;
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.pid !== "number" ||
		!Number.isSafeInteger(parsed.pid) ||
		parsed.pid <= 0 ||
		typeof parsed.token !== "string" ||
		typeof parsed.kind !== "string" ||
		typeof parsed.created_at !== "string"
	) {
		return null;
	}
	return {
		pid: parsed.pid,
		token: parsed.token,
		kind: parsed.kind,
		created_at: parsed.created_at,
	};
}

async function recoverDeadLease(context: StoreContext): Promise<boolean> {
	const lease = await readMutationLease(context);
	if (!lease || isProcessAlive(lease.pid)) return false;
	const stalePath = `${context.lockPath}.stale.${lease.token}`;
	try {
		await rename(context.lockPath, stalePath);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return true;
		return false;
	}
	try {
		await unlink(resolve(stalePath, "lease.json"));
		await rmdir(stalePath);
		await syncDirectory(context.storeRoot);
		return true;
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isFileSystemError(error, "ESRCH");
	}
}

async function mutationBlocker(context: StoreContext): Promise<string | null> {
	try {
		await access(context.lockPath, constants.F_OK);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return null;
		throw new UserError(`Cannot inspect the local version lease: ${errorMessage(error)}`, "storage_failed");
	}
	if (await recoverDeadLease(context)) return null;
	return lockBlocker(context);
}

function lockBlocker(context: StoreContext): string {
	return `Another process is changing this project. Wait for it to finish. Lock: ${context.lockPath}`;
}

async function publicStatus(
	context: StoreContext,
	store: VersionStore,
	source: string,
	blockers: string[] = [],
): Promise<ProjectVersionStatus> {
	const head = await readHeadVersion(context, store);
	const sourceVersioned = head?.source_hash === sourceRevision(source);
	return {
		initialized: true,
		enabled: store.enabled,
		store_root: context.storeRoot,
		config_path: context.configRelativePath,
		head_version: store.head_version,
		source_status: head ? (sourceVersioned ? "clean" : "modified") : "unversioned",
		source_versioned: sourceVersioned,
		write_blockers: blockers,
		restore_blockers: blockers,
	};
}

function absentStatus(context: StoreContext): ProjectVersionStatus {
	return {
		initialized: false,
		enabled: false,
		store_root: context.storeRoot,
		config_path: context.configRelativePath,
		head_version: null,
		source_status: "unversioned",
		source_versioned: false,
		write_blockers: [],
		restore_blockers: [],
	};
}

async function assertValidVersionSource(source: string, configPath: string): Promise<void> {
	const inspection = await inspectProjectSource(source, configPath);
	const validationError = inspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (validationError) throw new UserError(validationError.message, "invalid_source");
}

async function resolveConfigPath(configFile: string): Promise<string> {
	try {
		return await realpath(resolve(configFile));
	} catch (error) {
		throw new UserError(`Cannot read agents.yaml: ${errorMessage(error)}`, "invalid_source");
	}
}

async function atomicWriteConfig(configPath: string, source: string, expectedRevision: string): Promise<void> {
	const currentSource = await readFile(configPath, "utf8");
	assertSourceRevision(expectedRevision, currentSource);
	const fileStat = await stat(configPath);
	await atomicWrite(configPath, source, fileStat.mode & 0o777);
}

async function atomicWrite(path: string, source: string, mode: number): Promise<void> {
	const temporaryPath = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const handle = await open(temporaryPath, "wx", mode);
	try {
		await handle.writeFile(source, "utf8");
		await handle.sync();
		await chmod(temporaryPath, mode);
	} finally {
		await handle.close();
	}
	try {
		await rename(temporaryPath, path);
		await syncDirectory(dirname(path));
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function assertHeadVersion(expected: string, current: string | null): void {
	if (expected !== current) {
		throw new UserError("The current local version changed. Reload versions and retry.", "stale_snapshot");
	}
}

function assertSourceRevision(expected: string, source: string): void {
	if (sourceRevision(source) !== expected) {
		throw new UserError("agents.yaml changed. Preview the version again before restoring.", "stale_snapshot");
	}
}

function sourceRevision(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function assertVersionId(versionId: string): void {
	if (!isVersionId(versionId)) {
		throw new UserError("Version ID must be a full 64-character hexadecimal value.", "invalid_version");
	}
}

function isVersionId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function assertVersionMessage(message: string): void {
	if (!message.trim() || message !== message.trim() || message.length > 120 || /[\r\n]/.test(message)) {
		throw new UserError("Version message must be one trimmed line between 1 and 120 characters.", "invalid_source");
	}
}

function encodeCursor(input: { headVersion: string | null; offset: number }): string {
	return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function parseCursor(
	cursor: string | undefined,
	currentHead: string | null,
): { headVersion: string | null; offset: number } {
	if (!cursor) return { headVersion: currentHead, offset: 0 };
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			!isRecord(parsed) ||
			(parsed.headVersion !== null && !isVersionId(parsed.headVersion)) ||
			typeof parsed.offset !== "number" ||
			!Number.isSafeInteger(parsed.offset) ||
			parsed.offset < 0
		) {
			throw new Error("invalid");
		}
		return { headVersion: parsed.headVersion, offset: parsed.offset };
	} catch {
		throw new UserError("Version cursor is invalid.", "invalid_version");
	}
}

function localAuthorName(): string {
	return (
		process.env.OPENAGENTPACK_VERSION_AUTHOR?.trim() ||
		process.env.USER?.trim() ||
		process.env.USERNAME?.trim() ||
		"local"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function postApplyVersionError(reason: string): ProjectVersionError {
	return new UserError(
		`Remote Apply completed, but agents.yaml could not be versioned: ${reason}. Fix the local version store and rerun Apply; a no-op Apply will retry the version.`,
		"storage_failed",
	);
}

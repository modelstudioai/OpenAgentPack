import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "@openagentpack/sdk";
import { inspectProjectSource, UserError } from "@openagentpack/sdk";

const DIRECTORY_STORE_SCHEMA = 1;
const VERSION_ID = /^[a-f0-9]{64}$/;
const SENSITIVE_KEY = /(access[_-]?key|api[_-]?key|authorization|credential|headers?|password|secret|signature|token)/i;
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;

export class DirectoryProjectMutationConflictError extends UserError {
	readonly status = 409;

	constructor(message: string) {
		super(message);
		this.name = "DirectoryProjectMutationConflictError";
	}
}

export interface DirectorySnapshotFile {
	path: string;
	mode: number;
	content: Uint8Array;
}

export interface DirectoryProjectSnapshot {
	project_revision: string;
	canonical_yaml: string;
	files: DirectorySnapshotFile[];
}

export interface DirectoryProjectVersion {
	version_id: string;
	short_version: string;
	parent_version: string | null;
	tree_hash: string;
	yaml_hash: string;
	message: string;
	created_by: string;
	created_at: string;
}

export interface DirectoryProjectVersionStatus {
	initialized: boolean;
	enabled: boolean;
	store_root: string;
	head_version: string | null;
	source_status: "clean" | "modified" | "unversioned";
	project_revision: string;
	write_blockers: string[];
	restore_blockers: string[];
}

export interface DirectoryVersionFileChange {
	path: string;
	change: "create" | "update" | "delete";
	binary: boolean;
	before?: string;
	after?: string;
}

export interface DirectoryProjectVersionPreview {
	version_id: string;
	base_head_version: string;
	base_project_revision: string;
	before_yaml: string;
	after_yaml: string;
	changes: DirectoryVersionFileChange[];
	diagnostics: Diagnostic[];
	can_restore: boolean;
	blockers: string[];
}

export interface PreparedDirectoryProjectVersion {
	projectRoot: string;
	storeRoot: string;
	baseHeadVersion: string | null;
	snapshot: DirectoryProjectSnapshot;
	treeHash: string;
	needsVersion: boolean;
	versioningEnabled: boolean;
	leaseToken: string;
}

export interface DirectoryProjectVersionAdapter {
	readSnapshot(): Promise<DirectoryProjectSnapshot>;
	restoreSnapshot(snapshot: DirectoryProjectSnapshot, baseProjectRevision: string): Promise<void>;
}

interface StoredDirectoryProjectVersion extends DirectoryProjectVersion {
	manifest_hash: string;
	nonce: string;
}

interface DirectoryStore {
	schema_version: typeof DIRECTORY_STORE_SCHEMA;
	enabled: boolean;
	head_version: string | null;
}

interface StoredManifest {
	project_revision: string;
	canonical_yaml_hash: string;
	files: Array<{ path: string; mode: number; blob_hash: string; size: number }>;
}

interface DirectoryContext {
	projectRoot: string;
	storeRoot: string;
	storePath: string;
	entriesRoot: string;
	blobsRoot: string;
	manifestsRoot: string;
	lockRoot: string;
	leasePath: string;
}

interface MutationLease {
	token: string;
	pid: number;
	kind: string;
	created_at: string;
}

export interface DirectoryProjectVersionService {
	status(): Promise<DirectoryProjectVersionStatus>;
	enable(
		message?: string,
	): Promise<{ version: DirectoryProjectVersion | null; versioning: DirectoryProjectVersionStatus }>;
	disable(): Promise<DirectoryProjectVersionStatus>;
	listVersions(input?: {
		cursor?: string;
		limit?: number;
	}): Promise<{ versions: DirectoryProjectVersion[]; next_cursor: string | null }>;
	previewVersion(versionId: string): Promise<DirectoryProjectVersionPreview>;
	restoreVersion(
		versionId: string,
		base: { headVersion: string; projectRevision: string },
	): Promise<DirectoryProjectVersionPreview>;
	prepareVersion(snapshot?: DirectoryProjectSnapshot): Promise<PreparedDirectoryProjectVersion>;
	commitPrepared(prepared: PreparedDirectoryProjectVersion, message?: string): Promise<DirectoryProjectVersion | null>;
	releasePrepared(prepared: PreparedDirectoryProjectVersion | null): Promise<void>;
}

export function createDirectoryProjectVersionService(input: {
	projectRoot: string;
	adapter: DirectoryProjectVersionAdapter;
}): DirectoryProjectVersionService {
	const context = directoryContext(input.projectRoot);
	return {
		status: async () => status(context, input.adapter),
		enable: async (message = "Initialize project") => {
			const lease = await acquireLease(context, "version_enable");
			try {
				const snapshot = await input.adapter.readSnapshot();
				await assertSnapshotSafe(snapshot, context.projectRoot);
				const store = (await readStore(context, false)) ?? emptyStore();
				store.enabled = true;
				const head = store.head_version ? await readEntry(context, store.head_version) : null;
				const treeHash = snapshotTreeHash(snapshot);
				const version = head?.tree_hash === treeHash ? null : await appendVersion(context, store, snapshot, message);
				if (!version) await writeJsonAtomic(context.storePath, store);
				return { version, versioning: await publicStatus(context, store, snapshot) };
			} finally {
				await releaseLease(context, lease.token);
			}
		},
		disable: async () => {
			const lease = await acquireLease(context, "version_disable");
			try {
				const store = await requireStore(context);
				store.enabled = false;
				await writeJsonAtomic(context.storePath, store);
				return publicStatus(context, store, await input.adapter.readSnapshot());
			} finally {
				await releaseLease(context, lease.token);
			}
		},
		listVersions: async (options = {}) => listVersions(context, options),
		previewVersion: async (versionId) => previewVersion(context, input.adapter, versionId),
		restoreVersion: async (versionId, base) => restoreVersion(context, input.adapter, versionId, base),
		prepareVersion: async (provided) => prepareVersion(context, input.adapter, provided),
		commitPrepared: async (prepared, message = "Publish project") => commitPrepared(context, prepared, message),
		releasePrepared: async (prepared) => {
			if (prepared) await releaseLease(context, prepared.leaseToken);
		},
	};
}

async function status(
	context: DirectoryContext,
	adapter: DirectoryProjectVersionAdapter,
): Promise<DirectoryProjectVersionStatus> {
	const [store, snapshot, blocker] = await Promise.all([
		readStore(context, false),
		adapter.readSnapshot(),
		mutationBlocker(context),
	]);
	if (!store) {
		return {
			initialized: false,
			enabled: false,
			store_root: context.storeRoot,
			head_version: null,
			source_status: "unversioned",
			project_revision: snapshot.project_revision,
			write_blockers: blocker ? [blocker] : [],
			restore_blockers: blocker ? [blocker] : [],
		};
	}
	return publicStatus(context, store, snapshot, blocker ? [blocker] : []);
}

async function publicStatus(
	context: DirectoryContext,
	store: DirectoryStore,
	snapshot: DirectoryProjectSnapshot,
	blockers: string[] = [],
): Promise<DirectoryProjectVersionStatus> {
	const head = store.head_version ? await readEntry(context, store.head_version) : null;
	return {
		initialized: true,
		enabled: store.enabled,
		store_root: context.storeRoot,
		head_version: store.head_version,
		source_status: !head ? "unversioned" : head.tree_hash === snapshotTreeHash(snapshot) ? "clean" : "modified",
		project_revision: snapshot.project_revision,
		write_blockers: blockers,
		restore_blockers: blockers,
	};
}

async function listVersions(
	context: DirectoryContext,
	input: { cursor?: string; limit?: number },
): Promise<{ versions: DirectoryProjectVersion[]; next_cursor: string | null }> {
	const store = await requireStore(context);
	const cursor = input.cursor ? decodeCursor(input.cursor) : { head: store.head_version, offset: 0 };
	if (cursor.head !== store.head_version) throw new UserError("Version history changed. Restart pagination.");
	const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
	const chain = await readChain(context, store.head_version);
	return {
		versions: chain.slice(cursor.offset, cursor.offset + limit).map(publicVersion),
		next_cursor:
			cursor.offset + limit < chain.length
				? Buffer.from(JSON.stringify({ head: store.head_version, offset: cursor.offset + limit })).toString("base64url")
				: null,
	};
}

async function previewVersion(
	context: DirectoryContext,
	adapter: DirectoryProjectVersionAdapter,
	versionId: string,
): Promise<DirectoryProjectVersionPreview> {
	const store = await requireStore(context);
	if (!store.head_version) throw new UserError("The project version store has no versions.");
	const selected = await requireReachable(context, store.head_version, versionId);
	const [current, historical, blocker] = await Promise.all([
		adapter.readSnapshot(),
		readSnapshot(context, selected),
		mutationBlocker(context),
	]);
	return buildPreview(context, selected, store.head_version, current, historical, blocker ? [blocker] : []);
}

async function restoreVersion(
	context: DirectoryContext,
	adapter: DirectoryProjectVersionAdapter,
	versionId: string,
	base: { headVersion: string; projectRevision: string },
): Promise<DirectoryProjectVersionPreview> {
	const lease = await acquireLease(context, "version_restore");
	try {
		const store = await requireStore(context);
		if (store.head_version !== base.headVersion) throw new UserError("Version history changed. Preview again.");
		const selected = await requireReachable(context, base.headVersion, versionId);
		const [current, historical] = await Promise.all([adapter.readSnapshot(), readSnapshot(context, selected)]);
		if (current.project_revision !== base.projectRevision) {
			throw new UserError("Project files changed. Preview the version again before restoring.");
		}
		await assertSnapshotSafe(historical, context.projectRoot);
		await adapter.restoreSnapshot(historical, base.projectRevision);
		return buildPreview(context, selected, base.headVersion, current, historical, []);
	} finally {
		await releaseLease(context, lease.token);
	}
}

async function prepareVersion(
	context: DirectoryContext,
	adapter: DirectoryProjectVersionAdapter,
	provided?: DirectoryProjectSnapshot,
): Promise<PreparedDirectoryProjectVersion> {
	const lease = await acquireLease(context, "publish");
	try {
		const store = await readStore(context, false);
		const snapshot = provided ?? (await adapter.readSnapshot());
		await assertSnapshotSafe(snapshot, context.projectRoot);
		if (!store?.enabled) {
			return {
				projectRoot: context.projectRoot,
				storeRoot: context.storeRoot,
				baseHeadVersion: store?.head_version ?? null,
				snapshot,
				treeHash: snapshotTreeHash(snapshot),
				needsVersion: false,
				versioningEnabled: false,
				leaseToken: lease.token,
			};
		}
		if (!store.head_version) throw new UserError("Enabled project versioning has no baseline version.");
		const head = await readEntry(context, store.head_version);
		const treeHash = snapshotTreeHash(snapshot);
		return {
			projectRoot: context.projectRoot,
			storeRoot: context.storeRoot,
			baseHeadVersion: store.head_version,
			snapshot,
			treeHash,
			needsVersion: head.tree_hash !== treeHash,
			versioningEnabled: true,
			leaseToken: lease.token,
		};
	} catch (error) {
		await releaseLease(context, lease.token);
		throw error;
	}
}

async function commitPrepared(
	context: DirectoryContext,
	prepared: PreparedDirectoryProjectVersion,
	message: string,
): Promise<DirectoryProjectVersion | null> {
	try {
		await assertLease(context, prepared.leaseToken);
		if (prepared.projectRoot !== context.projectRoot || prepared.storeRoot !== context.storeRoot) {
			throw new UserError("Prepared version belongs to a different project.");
		}
		if (!prepared.versioningEnabled) return null;
		const store = await requireStore(context);
		if (!store.enabled || store.head_version !== prepared.baseHeadVersion) {
			throw new UserError("Project version history changed while Publish was running.");
		}
		if (!prepared.needsVersion) return null;
		return appendVersion(context, store, prepared.snapshot, message);
	} finally {
		await releaseLease(context, prepared.leaseToken);
	}
}

async function appendVersion(
	context: DirectoryContext,
	store: DirectoryStore,
	snapshot: DirectoryProjectSnapshot,
	message: string,
): Promise<DirectoryProjectVersion> {
	if (!message.trim() || /[\r\n]/.test(message)) throw new UserError("Version message must be one non-empty line.");
	const files = [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path));
	const manifest: StoredManifest = {
		project_revision: snapshot.project_revision,
		canonical_yaml_hash: hash(snapshot.canonical_yaml),
		files: [],
	};
	for (const file of files) {
		assertRelativePath(file.path);
		const blobHash = hash(file.content);
		await writeBlob(context, blobHash, file.content);
		manifest.files.push({ path: file.path, mode: file.mode, blob_hash: blobHash, size: file.content.byteLength });
	}
	const yamlHash = hash(snapshot.canonical_yaml);
	await writeBlob(context, yamlHash, new TextEncoder().encode(snapshot.canonical_yaml));
	const manifestSource = JSON.stringify(manifest);
	const manifestHash = hash(manifestSource);
	await writeJsonAtomic(resolve(context.manifestsRoot, `${manifestHash}.json`), manifest);
	const entryBase = {
		parent_version: store.head_version,
		tree_hash: snapshotTreeHash(snapshot),
		yaml_hash: yamlHash,
		manifest_hash: manifestHash,
		message: message.trim(),
		created_by: process.env.USER || process.env.USERNAME || "local-user",
		created_at: new Date().toISOString(),
		nonce: randomUUID(),
	};
	const versionId = hash(JSON.stringify(entryBase));
	const entry: StoredDirectoryProjectVersion = {
		version_id: versionId,
		short_version: versionId.slice(0, 12),
		...entryBase,
	};
	await writeJsonAtomic(resolve(context.entriesRoot, `${versionId}.json`), entry);
	store.head_version = versionId;
	await writeJsonAtomic(context.storePath, store);
	return publicVersion(entry);
}

async function readSnapshot(
	context: DirectoryContext,
	entry: StoredDirectoryProjectVersion,
): Promise<DirectoryProjectSnapshot> {
	const manifest = await readJson<StoredManifest>(resolve(context.manifestsRoot, `${entry.manifest_hash}.json`));
	const files = await Promise.all(
		manifest.files.map(async (file) => ({
			path: file.path,
			mode: file.mode,
			content: new Uint8Array(await readFile(resolve(context.blobsRoot, file.blob_hash))),
		})),
	);
	return {
		project_revision: manifest.project_revision,
		canonical_yaml: (await readFile(resolve(context.blobsRoot, entry.yaml_hash))).toString("utf8"),
		files,
	};
}

async function buildPreview(
	context: DirectoryContext,
	entry: StoredDirectoryProjectVersion,
	headVersion: string,
	current: DirectoryProjectSnapshot,
	historical: DirectoryProjectSnapshot,
	blockers: string[],
): Promise<DirectoryProjectVersionPreview> {
	const [currentInspection, historicalInspection] = await Promise.all([
		inspectProjectSource(current.canonical_yaml, resolve(context.projectRoot, ".openagentpack/build/agents.yaml")),
		inspectProjectSource(historical.canonical_yaml, resolve(context.projectRoot, ".openagentpack/build/agents.yaml")),
	]);
	const changes = diffSnapshots(current, historical);
	const canRestore =
		blockers.length === 0 && historicalInspection.diagnostics.every((diagnostic) => diagnostic.severity !== "error");
	return {
		version_id: entry.version_id,
		base_head_version: headVersion,
		base_project_revision: current.project_revision,
		before_yaml: currentInspection.redacted_source,
		after_yaml: historicalInspection.redacted_source,
		changes,
		diagnostics: historicalInspection.diagnostics,
		can_restore: canRestore,
		blockers,
	};
}

function diffSnapshots(
	current: DirectoryProjectSnapshot,
	historical: DirectoryProjectSnapshot,
): DirectoryVersionFileChange[] {
	const before = new Map(current.files.map((file) => [file.path, file]));
	const after = new Map(historical.files.map((file) => [file.path, file]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	const changes: DirectoryVersionFileChange[] = [];
	for (const path of paths) {
		const beforeFile = before.get(path);
		const afterFile = after.get(path);
		if (
			beforeFile &&
			afterFile &&
			hash(beforeFile.content) === hash(afterFile.content) &&
			beforeFile.mode === afterFile.mode
		) {
			continue;
		}
		const beforeText = beforeFile ? decodeText(beforeFile.content) : undefined;
		const afterText = afterFile ? decodeText(afterFile.content) : undefined;
		changes.push({
			path,
			change: !beforeFile ? "create" : !afterFile ? "delete" : "update",
			binary: (beforeFile !== undefined && beforeText === null) || (afterFile !== undefined && afterText === null),
			before: beforeText === null ? undefined : safeDiffText(path, beforeText),
			after: afterText === null ? undefined : safeDiffText(path, afterText),
		});
	}
	return changes;
}

function safeDiffText(path: string, content: string | undefined): string | undefined {
	if (content === undefined || !path.toLowerCase().endsWith(".json")) return content;
	try {
		return `${JSON.stringify(redactJson(JSON.parse(content)), null, 2)}\n`;
	} catch {
		return content;
	}
}

function redactJson(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((entry) => redactJson(entry));
	if (!value || typeof value !== "object") {
		return SENSITIVE_KEY.test(key) && typeof value === "string" && !ENV_REFERENCE.test(value) ? "[redacted]" : value;
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
			entryKey,
			redactJson(entry, entryKey),
		]),
	);
}

function decodeText(content: Uint8Array): string | null {
	if (content.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return null;
	}
}

async function assertSnapshotSafe(snapshot: DirectoryProjectSnapshot, projectRoot: string): Promise<void> {
	const inspection = await inspectProjectSource(
		snapshot.canonical_yaml,
		resolve(projectRoot, ".openagentpack/build/agents.yaml"),
	);
	const diagnostic = inspection.diagnostics.find((item) => item.severity === "error");
	if (diagnostic) throw new UserError(diagnostic.message);
	for (const file of snapshot.files) assertRelativePath(file.path);
}

function snapshotTreeHash(snapshot: DirectoryProjectSnapshot): string {
	const digest = createHash("sha256");
	for (const file of [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path))) {
		digest.update(file.path).update("\0").update(String(file.mode)).update("\0").update(file.content).update("\0");
	}
	return digest.digest("hex");
}

function directoryContext(projectRoot: string): DirectoryContext {
	const normalized = resolve(projectRoot);
	const storeRoot = resolve(normalized, ".openagentpack", "versions", "project");
	return {
		projectRoot: normalized,
		storeRoot,
		storePath: resolve(storeRoot, "store.json"),
		entriesRoot: resolve(storeRoot, "entries"),
		blobsRoot: resolve(storeRoot, "blobs"),
		manifestsRoot: resolve(storeRoot, "manifests"),
		lockRoot: resolve(normalized, ".openagentpack", "mutation.lock"),
		leasePath: resolve(normalized, ".openagentpack", "mutation.lock", "lease.json"),
	};
}

function emptyStore(): DirectoryStore {
	return { schema_version: DIRECTORY_STORE_SCHEMA, enabled: false, head_version: null };
}

async function readStore(context: DirectoryContext, required: boolean): Promise<DirectoryStore | null> {
	try {
		const value = await readJson<DirectoryStore>(context.storePath);
		if (
			value.schema_version !== DIRECTORY_STORE_SCHEMA ||
			typeof value.enabled !== "boolean" ||
			(value.head_version !== null && !VERSION_ID.test(value.head_version))
		) {
			throw new UserError("The project version store is invalid.");
		}
		return value;
	} catch (error) {
		if (isFsError(error, "ENOENT") && !required) return null;
		if (isFsError(error, "ENOENT")) throw new UserError("No project version store exists. Run project init first.");
		throw error;
	}
}

async function requireStore(context: DirectoryContext): Promise<DirectoryStore> {
	return (await readStore(context, true))!;
}

async function readEntry(context: DirectoryContext, versionId: string): Promise<StoredDirectoryProjectVersion> {
	assertVersionId(versionId);
	const entry = await readJson<StoredDirectoryProjectVersion>(resolve(context.entriesRoot, `${versionId}.json`));
	if (entry.version_id !== versionId || entry.short_version !== versionId.slice(0, 12)) {
		throw new UserError("A project version entry is invalid.");
	}
	return entry;
}

async function readChain(
	context: DirectoryContext,
	headVersion: string | null,
): Promise<StoredDirectoryProjectVersion[]> {
	const result: StoredDirectoryProjectVersion[] = [];
	const seen = new Set<string>();
	let current = headVersion;
	while (current) {
		if (seen.has(current)) throw new UserError("The project version history contains a cycle.");
		seen.add(current);
		const entry = await readEntry(context, current);
		result.push(entry);
		current = entry.parent_version;
	}
	return result;
}

async function requireReachable(
	context: DirectoryContext,
	headVersion: string,
	versionId: string,
): Promise<StoredDirectoryProjectVersion> {
	assertVersionId(versionId);
	const entry = (await readChain(context, headVersion)).find((candidate) => candidate.version_id === versionId);
	if (!entry) throw new UserError("Project version is not reachable from the current history.");
	return entry;
}

function publicVersion(entry: StoredDirectoryProjectVersion): DirectoryProjectVersion {
	return {
		version_id: entry.version_id,
		short_version: entry.short_version,
		parent_version: entry.parent_version,
		tree_hash: entry.tree_hash,
		yaml_hash: entry.yaml_hash,
		message: entry.message,
		created_by: entry.created_by,
		created_at: entry.created_at,
	};
}

async function writeBlob(context: DirectoryContext, blobHash: string, content: Uint8Array): Promise<void> {
	const path = resolve(context.blobsRoot, blobHash);
	try {
		await stat(path);
		return;
	} catch (error) {
		if (!isFsError(error, "ENOENT")) throw error;
	}
	await mkdir(context.blobsRoot, { recursive: true });
	await writeFile(path, content, { flag: "wx" }).catch(async (error) => {
		if (!isFsError(error, "EEXIST")) throw error;
	});
}

async function readJson<Value>(path: string): Promise<Value> {
	return JSON.parse(await readFile(path, "utf8")) as Value;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

async function acquireLease(context: DirectoryContext, kind: string): Promise<MutationLease> {
	await mkdir(dirname(context.lockRoot), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await mkdir(context.lockRoot);
			break;
		} catch (error) {
			if (!isFsError(error, "EEXIST")) throw error;
			if (attempt === 0 && (await recoverDeadLease(context))) continue;
			throw new DirectoryProjectMutationConflictError((await mutationBlocker(context)) ?? "Project is busy.");
		}
	}
	const lease = { token: randomUUID(), pid: process.pid, kind, created_at: new Date().toISOString() };
	try {
		await writeJsonAtomic(context.leasePath, lease);
		return lease;
	} catch (error) {
		await rm(context.lockRoot, { recursive: true, force: true });
		throw error;
	}
}

async function assertLease(context: DirectoryContext, token: string): Promise<void> {
	const lease = await readJson<MutationLease>(context.leasePath);
	if (lease.token !== token) throw new UserError("Project mutation lease changed.");
}

async function releaseLease(context: DirectoryContext, token: string): Promise<void> {
	try {
		await assertLease(context, token);
		await rm(context.lockRoot, { recursive: true, force: true });
	} catch (error) {
		if (!isFsError(error, "ENOENT")) throw error;
	}
}

async function mutationBlocker(context: DirectoryContext): Promise<string | null> {
	try {
		const lease = await readJson<MutationLease>(context.leasePath);
		if (!isProcessAlive(lease.pid) && (await recoverDeadLease(context))) return null;
		return `Project is busy with ${lease.kind} (pid ${lease.pid}).`;
	} catch (error) {
		return isFsError(error, "ENOENT") ? null : "Project mutation lock is unreadable.";
	}
}

async function recoverDeadLease(context: DirectoryContext): Promise<boolean> {
	let pid: number;
	try {
		const lease = await readJson<{ pid?: unknown }>(context.leasePath);
		if (typeof lease.pid !== "number" || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) return false;
		pid = lease.pid;
	} catch {
		return false;
	}
	if (isProcessAlive(pid)) return false;
	const stale = `${context.lockRoot}.stale.${randomUUID()}`;
	try {
		await rename(context.lockRoot, stale);
	} catch (error) {
		return isFsError(error, "ENOENT");
	}
	await rm(stale, { recursive: true, force: true });
	return true;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isFsError(error, "ESRCH");
	}
}

function decodeCursor(cursor: string): { head: string | null; offset: number } {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { head: unknown; offset: unknown };
		if (
			(value.head !== null && (typeof value.head !== "string" || !VERSION_ID.test(value.head))) ||
			!Number.isInteger(value.offset) ||
			Number(value.offset) < 0
		) {
			throw new Error("invalid");
		}
		return { head: value.head as string | null, offset: Number(value.offset) };
	} catch {
		throw new UserError("Invalid project version cursor.");
	}
}

function hash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function assertRelativePath(path: string): void {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new UserError(`Invalid project snapshot path: ${path}`);
	}
}

function assertVersionId(versionId: string): void {
	if (!VERSION_ID.test(versionId)) throw new UserError("Project version must be a full 64-character SHA-256 id.");
}

function isFsError(error: unknown, code: string): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === code;
}

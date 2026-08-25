import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type Diagnostic, inspectProjectSource, UserError as SdkUserError } from "@openagentpack/sdk";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const ZERO_SHA1 = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);

export type LocalGitErrorCode =
	| "git_unavailable"
	| "repository_missing"
	| "repository_blocked"
	| "stale_snapshot"
	| "invalid_version"
	| "invalid_source"
	| "git_failed";

export class LocalGitError extends SdkUserError {
	constructor(
		message: string,
		readonly code: LocalGitErrorCode = "git_failed",
	) {
		super(message);
		this.name = "LocalGitError";
	}
}

const UserError = LocalGitError;

export type LocalGitConfigStatus = "clean" | "modified" | "untracked" | "staged" | "conflicted";

export interface LocalVersionStatus {
	git_available: boolean;
	enabled: boolean;
	repository_root: string | null;
	config_path: string | null;
	branch: string | null;
	head: string | null;
	config_status: LocalGitConfigStatus;
	config_versioned: boolean;
	commit_blockers: string[];
	restore_blockers: string[];
}

export interface LocalProjectVersion {
	commit: string;
	short_commit: string;
	message: string;
	author_name: string;
	authored_at: string;
}

export interface LocalProjectVersionsPage {
	versions: LocalProjectVersion[];
	next_cursor: string | null;
}

export interface LocalVersionPreview {
	commit: string;
	base_head: string;
	base_source_revision: string;
	before_yaml: string;
	after_yaml: string;
	diagnostics: Diagnostic[];
	can_restore: boolean;
	blockers: string[];
}

export interface PreparedAutomaticVersion {
	configPath: string;
	repositoryRoot: string;
	configRelativePath: string;
	branch: string;
	head: string | null;
	source: string;
	needsCommit: boolean;
}

interface RepositoryContext {
	root: string;
	configPath: string;
	configRelativePath: string;
	branch: string | null;
	head: string | null;
	objectFormat: "sha1" | "sha256";
	configStatus: LocalGitConfigStatus;
	configVersioned: boolean;
	operationBlockers: string[];
	identityBlockers: string[];
	enabled: boolean;
}

interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export async function readVersionSource(configFile: string): Promise<{ configPath: string; source: string }> {
	const configPath = await resolveConfigPath(configFile);
	return { configPath, source: await readFile(configPath, "utf8") };
}

export async function getLocalVersionStatus(configFile: string): Promise<LocalVersionStatus> {
	const gitAvailable = await isGitAvailable();
	if (!gitAvailable) return unavailableStatus();
	const configPath = await resolveConfigPath(configFile);
	const repository = await discoverRepository(configPath);
	if (!repository) return absentStatus();
	return publicStatus(await loadRepositoryContext(repository, configPath));
}

export async function initializeLocalGitRepository(configFile: string): Promise<LocalVersionStatus> {
	assertGitAvailable(await isGitAvailable());
	const configPath = await resolveConfigPath(configFile);
	let repository = await discoverRepository(configPath);
	if (!repository) {
		await runGit(["init", "--initial-branch", "main"], dirname(configPath));
		repository = await discoverRepository(configPath);
	}
	if (!repository) throw new UserError("Git repository initialization did not produce a repository.");
	return publicStatus(await loadRepositoryContext(repository, configPath));
}

export async function enableLocalVersioning(
	configFile: string,
	message = "Enable OpenAgentPack versioning",
): Promise<{ version: LocalProjectVersion | null; git: LocalVersionStatus }> {
	assertGitAvailable(await isGitAvailable());
	const { configPath, source } = await readVersionSource(configFile);
	let repository = await discoverRepository(configPath);
	if (!repository) {
		await runGit(["init", "--initial-branch", "main"], dirname(configPath));
		repository = await discoverRepository(configPath);
	}
	if (!repository) throw new UserError("Git repository initialization did not produce a repository.");

	let context = await loadRepositoryContext(repository, configPath);
	if (context.enabled && context.configVersioned) {
		return { version: null, git: publicStatus(context) };
	}
	const enableBlockers = repositoryBlockers(context);
	if (enableBlockers.length > 0) throw new UserError(enableBlockers[0]!);
	await assertValidVersionSource(source, configPath);
	const version = context.configVersioned ? null : await createConfigCommit(context, source, message);
	context = await loadRepositoryContext(repository, configPath);
	if (!context.enabled) await writeVersionMarker(context.root, context.configRelativePath);
	return { version, git: publicStatus(await loadRepositoryContext(repository, configPath)) };
}

export async function disableLocalVersioning(configFile: string): Promise<LocalVersionStatus> {
	assertGitAvailable(await isGitAvailable());
	const configPath = await resolveConfigPath(configFile);
	const context = await requireRepositoryContext(configPath);
	await removeVersionMarker(context.root, context.configRelativePath);
	return publicStatus(await loadRepositoryContext(context.root, configPath));
}

export async function listLocalVersions(
	configFile: string,
	input: { cursor?: string; limit?: number } = {},
): Promise<LocalProjectVersionsPage> {
	const configPath = await resolveConfigPath(configFile);
	const context = await requireRepositoryContext(configPath);
	if (!context.head) return { versions: [], next_cursor: null };
	const offset = parseCursor(input.cursor);
	const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
	const output = await runGit(
		[
			"log",
			`--skip=${offset}`,
			`--max-count=${limit + 1}`,
			"--format=%H%x00%s%x00%an%x00%aI",
			"HEAD",
			"--",
			context.configRelativePath,
		],
		context.root,
	);
	const entries = output.stdout.trim().split("\n").filter(Boolean).map(parseVersionLine);
	const hasMore = entries.length > limit;
	return {
		versions: entries.slice(0, limit),
		next_cursor: hasMore ? String(offset + limit) : null,
	};
}

export async function previewLocalVersion(configFile: string, commit: string): Promise<LocalVersionPreview> {
	const configPath = await resolveConfigPath(configFile);
	const context = await requireRepositoryContext(configPath);
	await assertReachableCommit(context, commit);
	const [currentSource, historicalSource] = await Promise.all([
		readFile(configPath, "utf8"),
		readHistoricalConfig(context, commit),
	]);
	const [currentInspection, historicalInspection] = await Promise.all([
		inspectProjectSource(currentSource, configPath),
		inspectProjectSource(historicalSource, configPath),
	]);
	const freshContext = await loadRepositoryContext(context.root, configPath);
	assertBaseHead(context.head, freshContext.head);
	assertSameBranch(context.branch, freshContext.branch);
	if (!context.head) throw new UserError("The current branch has no versions.");
	const blockers = restoreBlockers(context);
	return {
		commit,
		base_head: context.head,
		base_source_revision: sourceRevision(currentSource),
		before_yaml: currentInspection.redacted_source,
		after_yaml: historicalInspection.redacted_source,
		diagnostics: historicalInspection.diagnostics,
		can_restore:
			historicalInspection.diagnostics.every((diagnostic) => diagnostic.severity !== "error") && blockers.length === 0,
		blockers,
	};
}

export async function restoreLocalVersion(
	configFile: string,
	commit: string,
	base: { head: string; sourceRevision: string },
): Promise<LocalVersionPreview> {
	let temporaryPath: string | undefined;
	try {
		const configPath = await resolveConfigPath(configFile);
		const context = await requireRepositoryContext(configPath);
		assertBaseHead(base.head, context.head);
		assertWriteableRepository(context, "restore");
		await assertReachableCommit(context, commit);
		const currentSource = await readFile(configPath, "utf8");
		assertSourceRevision(base.sourceRevision, currentSource);
		const preview = await previewLocalVersion(configPath, commit);
		if (!preview.can_restore) {
			const message =
				preview.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
				preview.blockers[0] ??
				"This version cannot be restored.";
			throw new UserError(message);
		}

		const historicalSource = await readHistoricalConfig(context, commit);
		const fileStat = await stat(configPath);
		temporaryPath = resolve(dirname(configPath), `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, historicalSource, { encoding: "utf8", mode: fileStat.mode });
		const freshSource = await readFile(configPath, "utf8");
		assertSourceRevision(base.sourceRevision, freshSource);
		const freshContext = await loadRepositoryContext(context.root, configPath);
		assertBaseHead(base.head, freshContext.head);
		assertSameBranch(context.branch, freshContext.branch);
		assertWriteableRepository(freshContext, "restore");
		await rename(temporaryPath, configPath);
		temporaryPath = undefined;
		return preview;
	} finally {
		if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
	}
}

export async function prepareAutomaticVersion(
	configFile: string,
	expectedSource: string,
): Promise<PreparedAutomaticVersion | null> {
	if (!(await isGitAvailable())) return null;
	const configPath = await resolveConfigPath(configFile);
	const repository = await discoverRepository(configPath);
	if (!repository) return null;
	const context = await loadRepositoryContext(repository, configPath);
	if (!context.enabled) return null;
	const source = await readFile(configPath, "utf8");
	if (source !== expectedSource) {
		throw new UserError("agents.yaml changed while Apply was being planned. Rerun Apply with the current file.");
	}
	const baseBlockers = repositoryBlockers(context);
	if (baseBlockers.length > 0) throw new UserError(baseBlockers[0]!);
	if (!context.branch) throw new UserError("Detached HEAD is not supported. Switch to a branch before Apply.");
	await assertValidVersionSource(source, configPath);
	if (!context.configVersioned) {
		assertWriteableRepository(context, "commit");
	}
	return {
		configPath,
		repositoryRoot: context.root,
		configRelativePath: context.configRelativePath,
		branch: context.branch,
		head: context.head,
		source,
		needsCommit: !context.configVersioned,
	};
}

export async function commitAutomaticVersion(
	prepared: PreparedAutomaticVersion,
	message = "Apply agents.yaml",
): Promise<LocalProjectVersion | null> {
	try {
		const currentSource = await readFile(prepared.configPath, "utf8");
		if (currentSource !== prepared.source) {
			throw new UserError("agents.yaml changed while Apply was running");
		}
		const context = await loadRepositoryContext(prepared.repositoryRoot, prepared.configPath);
		if (!context.enabled) throw new UserError("automatic versioning was disabled while Apply was running");
		assertBaseHead(prepared.head, context.head);
		assertSameBranch(prepared.branch, context.branch);
		if (!prepared.needsCommit && context.configVersioned) return null;
		return await createConfigCommit(context, prepared.source, message);
	} catch (error) {
		throw postApplyVersionError(error instanceof Error ? error.message : String(error));
	}
}

export async function commitLocalVersion(
	configFile: string,
	input: { source: string; message: string; baseHead: string | null },
): Promise<{ version: LocalProjectVersion; git: LocalVersionStatus }> {
	const configPath = await resolveConfigPath(configFile);
	const context = await requireRepositoryContext(configPath);
	assertBaseHead(input.baseHead, context.head);
	const version = await createConfigCommit(context, input.source, input.message);
	if (!version) throw new LocalGitError("agents.yaml has no changes to version.", "repository_blocked");
	return { version, git: publicStatus(await loadRepositoryContext(context.root, configPath)) };
}

export interface LocalGitVersionService {
	readSource(): Promise<{ configPath: string; source: string }>;
	status(): Promise<LocalVersionStatus>;
	initialize(): Promise<LocalVersionStatus>;
	enable(message?: string): Promise<{ version: LocalProjectVersion | null; git: LocalVersionStatus }>;
	disable(): Promise<LocalVersionStatus>;
	listVersions(input?: { cursor?: string; limit?: number }): Promise<LocalProjectVersionsPage>;
	previewVersion(commit: string): Promise<LocalVersionPreview>;
	restoreVersion(commit: string, base: { head: string; sourceRevision: string }): Promise<LocalVersionPreview>;
	prepareAutomaticVersion(expectedSource: string): Promise<PreparedAutomaticVersion | null>;
	commitAutomaticVersion(prepared: PreparedAutomaticVersion, message?: string): Promise<LocalProjectVersion | null>;
	prepareCommit(expectedSource: string): Promise<PreparedAutomaticVersion | null>;
	commitPrepared(prepared: PreparedAutomaticVersion, message?: string): Promise<LocalProjectVersion | null>;
	commitVersion(input: {
		source: string;
		message: string;
		baseHead: string | null;
	}): Promise<{ version: LocalProjectVersion; git: LocalVersionStatus }>;
}

export function createLocalGitVersionService(input: { configPath: string }): LocalGitVersionService {
	const configPath = input.configPath;
	return {
		readSource: () => readVersionSource(configPath),
		status: () => getLocalVersionStatus(configPath),
		initialize: () => initializeLocalGitRepository(configPath),
		enable: (message) => enableLocalVersioning(configPath, message),
		disable: () => disableLocalVersioning(configPath),
		listVersions: (options) => listLocalVersions(configPath, options),
		previewVersion: (commit) => previewLocalVersion(configPath, commit),
		restoreVersion: (commit, base) => restoreLocalVersion(configPath, commit, base),
		prepareAutomaticVersion: (expectedSource) => prepareAutomaticVersion(configPath, expectedSource),
		commitAutomaticVersion: (prepared, message) => commitAutomaticVersion(prepared, message),
		prepareCommit: (expectedSource) => prepareAutomaticVersion(configPath, expectedSource),
		commitPrepared: (prepared, message) => commitAutomaticVersion(prepared, message),
		commitVersion: (options) => commitLocalVersion(configPath, options),
	};
}

async function createConfigCommit(
	context: RepositoryContext,
	source: string,
	message: string,
): Promise<LocalProjectVersion | null> {
	if (context.configVersioned) return null;
	assertVersionMessage(message);
	assertWriteableRepository(context, "commit");
	await assertValidVersionSource(source, context.configPath);
	let temporaryDirectory: string | undefined;
	try {
		temporaryDirectory = await mkdtemp(resolve(tmpdir(), "openagentpack-git-index-"));
		const temporaryIndex = resolve(temporaryDirectory, "index");
		const gitEnvironment = { GIT_INDEX_FILE: temporaryIndex };
		if (context.head) await runGit(["read-tree", context.head], context.root, gitEnvironment);
		else await runGit(["read-tree", "--empty"], context.root, gitEnvironment);
		await runGit(["add", "--", context.configRelativePath], context.root, gitEnvironment);
		await assertCommitSnapshot(context, source);

		const tree = (await runGit(["write-tree"], context.root, gitEnvironment)).stdout.trim();
		const commitArguments = ["commit-tree", tree, "-m", message];
		if (context.head) commitArguments.push("-p", context.head);
		const commit = (await runGit(commitArguments, context.root)).stdout.trim();
		const indexEntry = (
			await runGit(["ls-files", "--stage", "--", context.configRelativePath], context.root, gitEnvironment)
		).stdout
			.trim()
			.split(/\s+/);
		const [fileMode, blob] = indexEntry;
		if (!fileMode || !blob) throw new UserError("Git could not index agents.yaml.");

		const finalContext = await assertCommitSnapshot(context, source);
		const expectedOld = finalContext.head ?? (finalContext.objectFormat === "sha256" ? ZERO_SHA256 : ZERO_SHA1);
		const branchRef = `refs/heads/${finalContext.branch!}`;
		try {
			await runGit(["update-ref", branchRef, commit, expectedOld], context.root);
		} catch (error) {
			const afterFailure = await loadRepositoryContext(context.root, context.configPath);
			if (afterFailure.head !== finalContext.head) {
				throw new UserError("Git HEAD changed. Reload versions and retry.");
			}
			throw error;
		}
		try {
			await runGit(
				["update-index", "--add", "--cacheinfo", `${fileMode},${blob},${context.configRelativePath}`],
				context.root,
			);
		} catch (error) {
			if (finalContext.head) await runGit(["update-ref", branchRef, finalContext.head, commit], context.root);
			else await runGit(["update-ref", "-d", branchRef, commit], context.root);
			throw error;
		}
		return readVersion(context.root, commit);
	} finally {
		if (temporaryDirectory) await removeTemporaryIndex(temporaryDirectory);
	}
}

async function assertCommitSnapshot(context: RepositoryContext, source: string): Promise<RepositoryContext> {
	const currentSource = await readFile(context.configPath, "utf8");
	if (currentSource !== source) throw new UserError("agents.yaml changed. Reload versions and retry.");
	const freshContext = await loadRepositoryContext(context.root, context.configPath);
	assertBaseHead(context.head, freshContext.head);
	assertSameBranch(context.branch, freshContext.branch);
	assertWriteableRepository(freshContext, "commit");
	return freshContext;
}

async function assertValidVersionSource(source: string, configPath: string): Promise<void> {
	const inspection = await inspectProjectSource(source, configPath);
	const validationError = inspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (validationError) throw new UserError(validationError.message);
}

async function resolveConfigPath(configFile: string): Promise<string> {
	try {
		return await realpath(resolve(configFile));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new UserError(`Cannot read agents.yaml: ${message}`);
	}
}

async function requireRepositoryContext(configPath: string): Promise<RepositoryContext> {
	assertGitAvailable(await isGitAvailable());
	const repository = await discoverRepository(configPath);
	if (!repository) throw new UserError("No Git repository contains agents.yaml. Run `agents version enable` first.");
	return loadRepositoryContext(repository, configPath);
}

async function loadRepositoryContext(root: string, configPath: string): Promise<RepositoryContext> {
	const [canonicalRoot, canonicalConfigPath] = await Promise.all([realpath(root), realpath(configPath)]);
	const configRelativePath = relative(canonicalRoot, canonicalConfigPath);
	if (
		!configRelativePath ||
		configRelativePath.startsWith("..") ||
		resolve(canonicalRoot, configRelativePath) !== canonicalConfigPath
	) {
		throw new UserError("agents.yaml is outside the discovered Git repository.");
	}
	const [branchResult, headResult, objectFormatResult, configFileStatus] = await Promise.all([
		runGitAllowFailure(["symbolic-ref", "--quiet", "--short", "HEAD"], canonicalRoot),
		runGitAllowFailure(["rev-parse", "--verify", "HEAD"], canonicalRoot),
		runGitAllowFailure(["rev-parse", "--show-object-format"], canonicalRoot),
		configStatus(canonicalRoot, configRelativePath),
	]);
	const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
	const [configVersioned, operationBlockers, gitIdentityBlockers, enabled] = await Promise.all([
		head ? isConfigVersioned(canonicalRoot, configRelativePath) : Promise.resolve(false),
		gitOperationBlockers(canonicalRoot),
		identityBlockers(canonicalRoot),
		isVersioningEnabled(canonicalRoot, configRelativePath),
	]);
	return {
		root: canonicalRoot,
		configPath: canonicalConfigPath,
		configRelativePath,
		branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
		head,
		objectFormat: objectFormatResult.stdout.trim() === "sha256" ? "sha256" : "sha1",
		configStatus: configFileStatus,
		configVersioned,
		operationBlockers,
		identityBlockers: gitIdentityBlockers,
		enabled,
	};
}

function publicStatus(context: RepositoryContext): LocalVersionStatus {
	const baseBlockers = repositoryBlockers(context);
	return {
		git_available: true,
		enabled: context.enabled,
		repository_root: context.root,
		config_path: context.configRelativePath,
		branch: context.branch,
		head: context.head,
		config_status: context.configStatus,
		config_versioned: context.configVersioned,
		commit_blockers: [...baseBlockers, ...context.identityBlockers],
		restore_blockers: baseBlockers,
	};
}

function unavailableStatus(): LocalVersionStatus {
	const blocker = "Git is not installed or is not available on PATH.";
	return {
		git_available: false,
		enabled: false,
		repository_root: null,
		config_path: null,
		branch: null,
		head: null,
		config_status: "untracked",
		config_versioned: false,
		commit_blockers: [blocker],
		restore_blockers: [blocker],
	};
}

function absentStatus(): LocalVersionStatus {
	const blocker = "No Git repository contains agents.yaml.";
	return {
		git_available: true,
		enabled: false,
		repository_root: null,
		config_path: null,
		branch: null,
		head: null,
		config_status: "untracked",
		config_versioned: false,
		commit_blockers: [blocker],
		restore_blockers: [blocker],
	};
}

function repositoryBlockers(context: RepositoryContext): string[] {
	const blockers = [...context.operationBlockers];
	if (!context.branch) blockers.push("Detached HEAD is not supported. Switch to a branch before changing versions.");
	if (context.configStatus === "staged") blockers.push("agents.yaml is already staged in the repository index.");
	if (context.configStatus === "conflicted") blockers.push("agents.yaml has unresolved Git conflicts.");
	return blockers;
}

function restoreBlockers(context: RepositoryContext): string[] {
	return repositoryBlockers(context);
}

function assertWriteableRepository(context: RepositoryContext, action: "commit" | "restore"): void {
	const blockers =
		action === "commit" ? [...repositoryBlockers(context), ...context.identityBlockers] : restoreBlockers(context);
	if (blockers.length > 0) throw new UserError(blockers[0]!);
}

async function discoverRepository(configPath: string): Promise<string | null> {
	const result = await runGitAllowFailure(["rev-parse", "--show-toplevel"], dirname(configPath));
	return result.exitCode === 0 ? resolve(result.stdout.trim()) : null;
}

async function configStatus(root: string, configRelativePath: string): Promise<LocalGitConfigStatus> {
	const output = (await runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", configRelativePath], root))
		.stdout;
	if (!output) return "clean";
	const code = output.slice(0, 2);
	if (code === "??") return "untracked";
	if (code.includes("U") || ["AA", "DD"].includes(code)) return "conflicted";
	if (code[0] !== " ") return "staged";
	return "modified";
}

async function isConfigVersioned(root: string, configRelativePath: string): Promise<boolean> {
	const tracked = await runGitAllowFailure(["cat-file", "-e", `HEAD:${configRelativePath}`], root);
	if (tracked.exitCode !== 0) return false;
	const diff = await runGitAllowFailure(["diff", "--quiet", "HEAD", "--", configRelativePath], root);
	return diff.exitCode === 0;
}

async function gitOperationBlockers(root: string): Promise<string[]> {
	const names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];
	for (const name of names) {
		const result = await runGitAllowFailure(["rev-parse", "--git-path", name], root);
		if (result.exitCode !== 0) continue;
		if (existsSync(resolve(root, result.stdout.trim()))) {
			return [`A Git ${name.toLowerCase().replaceAll("_", " ")} operation is in progress.`];
		}
	}
	return [];
}

async function identityBlockers(root: string): Promise<string[]> {
	const [name, email] = await Promise.all([
		runGitAllowFailure(["config", "--get", "user.name"], root),
		runGitAllowFailure(["config", "--get", "user.email"], root),
	]);
	const environmentName = process.env.GIT_AUTHOR_NAME?.trim() || process.env.GIT_COMMITTER_NAME?.trim();
	const environmentEmail = process.env.GIT_AUTHOR_EMAIL?.trim() || process.env.GIT_COMMITTER_EMAIL?.trim();
	const blockers: string[] = [];
	if ((name.exitCode !== 0 || !name.stdout.trim()) && !environmentName) {
		blockers.push('Git user.name is missing. Run: git config user.name "Your Name"');
	}
	if ((email.exitCode !== 0 || !email.stdout.trim()) && !environmentEmail) {
		blockers.push('Git user.email is missing. Run: git config user.email "you@example.com"');
	}
	return blockers;
}

function versionMarkerName(configRelativePath: string): string {
	const digest = createHash("sha256").update(configRelativePath).digest("hex").slice(0, 32);
	return `${digest}.marker`;
}

async function isVersioningEnabled(root: string, configRelativePath: string): Promise<boolean> {
	const markerPath = await versionMarkerPath(root, configRelativePath);
	try {
		return (await readFile(markerPath, "utf8")).trim() === configRelativePath;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw new UserError(`Cannot read the automatic versioning marker: ${errorMessage(error)}`);
	}
}

async function writeVersionMarker(root: string, configRelativePath: string): Promise<void> {
	const markerPath = await versionMarkerPath(root, configRelativePath);
	const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(markerPath), { recursive: true });
		await writeFile(temporaryPath, `${configRelativePath}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, markerPath);
	} catch (error) {
		throw new UserError(`Cannot enable automatic versioning for this worktree: ${errorMessage(error)}`);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

async function removeVersionMarker(root: string, configRelativePath: string): Promise<void> {
	const markerPath = await versionMarkerPath(root, configRelativePath);
	try {
		await unlink(markerPath);
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) {
			throw new UserError(`Cannot disable automatic versioning for this worktree: ${errorMessage(error)}`);
		}
	}
}

async function versionMarkerPath(root: string, configRelativePath: string): Promise<string> {
	const result = await runGit(
		["rev-parse", "--git-path", `openagentpack/local-git/versions/${versionMarkerName(configRelativePath)}`],
		root,
	);
	return resolve(root, result.stdout.trim());
}

function isFileSystemError(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function assertReachableCommit(context: RepositoryContext, commit: string): Promise<void> {
	if (!context.head) throw new UserError("The current branch has no versions.");
	const expectedLength = context.objectFormat === "sha256" ? 64 : 40;
	if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(commit)) {
		throw new UserError("Version commit must be a full hexadecimal commit SHA.");
	}
	const object = await runGitAllowFailure(["cat-file", "-e", `${commit}^{commit}`], context.root);
	if (object.exitCode !== 0) throw new UserError("Version commit was not found.");
	const reachable = await runGitAllowFailure(["merge-base", "--is-ancestor", commit, context.head], context.root);
	if (reachable.exitCode !== 0) throw new UserError("Version commit is not reachable from the current HEAD.");
	const touched = await runGit(
		["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit, "--", context.configRelativePath],
		context.root,
	);
	if (!touched.stdout.split("\n").includes(context.configRelativePath)) {
		throw new UserError("Version commit did not modify agents.yaml.");
	}
}

async function readHistoricalConfig(context: RepositoryContext, commit: string): Promise<string> {
	const result = await runGitAllowFailure(
		["cat-file", "blob", `${commit}:${context.configRelativePath}`],
		context.root,
	);
	if (result.exitCode !== 0) throw new UserError("agents.yaml does not exist in this version.");
	return result.stdout;
}

async function readVersion(root: string, commit: string): Promise<LocalProjectVersion> {
	const output = (await runGit(["show", "-s", "--format=%H%x00%s%x00%an%x00%aI", commit], root)).stdout.trim();
	return parseVersionLine(output);
}

function parseVersionLine(line: string): LocalProjectVersion {
	const [commit, message, authorName, authoredAt] = line.split("\0");
	if (!commit || message === undefined || authorName === undefined || authoredAt === undefined) {
		throw new UserError("Git returned an invalid version entry.");
	}
	return {
		commit,
		short_commit: commit.slice(0, 12),
		message,
		author_name: authorName,
		authored_at: authoredAt,
	};
}

function assertBaseHead(expected: string | null, current: string | null): void {
	if (expected !== current) throw new UserError("Git HEAD changed. Reload versions and retry.");
}

function assertSameBranch(expected: string | null, current: string | null): void {
	if (expected !== current) throw new UserError("The current Git branch changed. Reload versions and retry.");
}

function assertSourceRevision(expected: string, source: string): void {
	if (sourceRevision(source) !== expected)
		throw new UserError("agents.yaml changed. Preview the version again before restoring.");
}

function sourceRevision(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function assertVersionMessage(message: string): void {
	if (!message.trim() || message !== message.trim() || message.length > 120 || /[\r\n]/.test(message)) {
		throw new UserError("Version message must be one trimmed line between 1 and 120 characters.");
	}
}

function parseCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	if (!/^\d+$/.test(cursor)) throw new UserError("Version cursor is invalid.");
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset)) throw new UserError("Version cursor is invalid.");
	return offset;
}

function assertGitAvailable(available: boolean): void {
	if (!available) throw new UserError("Git is not installed or is not available on PATH.");
}

async function isGitAvailable(): Promise<boolean> {
	return (await runGitAllowFailure(["--version"], process.cwd())).exitCode === 0;
}

async function runGit(args: string[], cwd: string, environment: Record<string, string> = {}): Promise<GitResult> {
	const result = await runGitAllowFailure(args, cwd, environment);
	if (result.exitCode !== 0) throw new UserError(result.stderr.trim() || "Git command failed.");
	return result;
}

async function runGitAllowFailure(
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<GitResult> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			env: { ...process.env, ...environment },
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			exitCode: typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1,
		};
	}
}

async function removeTemporaryIndex(directory: string): Promise<void> {
	await unlink(resolve(directory, "index.lock")).catch(() => undefined);
	await unlink(resolve(directory, "index")).catch(() => undefined);
	await rmdir(directory).catch(() => undefined);
}

function postApplyVersionError(reason: string): LocalGitError {
	return new UserError(
		`Remote Apply completed, but agents.yaml could not be versioned: ${reason}. Fix the Git state and rerun Apply; a no-op Apply will retry the commit.`,
	);
}

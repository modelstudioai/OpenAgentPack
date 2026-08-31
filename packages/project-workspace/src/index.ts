import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	createDirectoryProjectVersionService,
	type DirectoryProjectSnapshot,
	type DirectoryProjectVersionService,
} from "@openagentpack/project-versions";
import {
	LocalFileStateBackend,
	type Diagnostic,
	type LoadedProjectConfig,
	type PlannedAction,
	type ResourcePlanResult,
	type ResourceSyncRun,
	type RuntimeFeedbackSink,
	inspectProjectSource,
	planProjectWithStateBackend,
	resolveProjectConfigFromObject,
	resolveProjectConfig,
	syncProjectResourcesWithStateBackend,
	UserError,
	validateProjectConfig,
} from "@openagentpack/sdk";
import { parse, stringify } from "yaml";

export const PROJECT_METADATA_FILE = "project.json";
export const PROJECT_INTERNAL_DIRECTORY = ".openagentpack";
export const PROJECT_BUILD_FILE = ".openagentpack/build/agents.yaml";
export const PROJECT_BUILD_MANIFEST = ".openagentpack/build/manifest.json";
export const PROJECT_STATE_FILE = ".openagentpack/state.json";

const IGNORED_ROOT_NAMES = new Set([
	".git",
	".openagentpack",
	".env",
	"agents.yaml",
	"agents.state.json",
	"node_modules",
	"dist",
	"build",
	".cache",
	".DS_Store",
]);

export class DirectoryProjectMutationConflictError extends UserError {
	readonly status = 409;

	constructor(message: string) {
		super(message);
		this.name = "DirectoryProjectMutationConflictError";
	}
}

export interface ProjectSourceFile {
	path: string;
	mode: number;
	content: Uint8Array;
}

export interface ProjectOrganizationMove {
	skill_id: string;
	from: string;
	to: string;
	reason: "shared";
}

export interface DirectoryProjectInspection {
	project_root: string;
	project_revision: string;
	source_manifest_hash: string;
	canonical_yaml: string;
	yaml_hash: string;
	loaded: LoadedProjectConfig | null;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
	organization_moves: ProjectOrganizationMove[];
	source_files: ProjectSourceFile[];
}

export interface ProjectBuildManifest {
	schema_version: 1;
	project_revision: string;
	source_manifest_hash: string;
	yaml_hash: string;
	built_at: string;
}

export interface ProjectBuildStatus {
	exists: boolean;
	stale: boolean;
	manifest: ProjectBuildManifest | null;
	reasons: string[];
}

export interface ProjectBuildPreview extends DirectoryProjectInspection {
	before_yaml: string;
	after_yaml: string;
	build_status: ProjectBuildStatus;
	can_build: boolean;
}

export interface InitializedDirectoryProject {
	project_root: string;
	converted_from_yaml: boolean;
	state_migrated: boolean;
	baseline_version: string | null;
}

export interface ProjectPublishPlan {
	project_root: string;
	project_revision: string;
	build_manifest: ProjectBuildManifest;
	build_path: string;
	planned: ResourcePlanResult;
}

export interface ProjectPublishResult {
	planned: ResourcePlanResult;
	execution: ResourceSyncRun["execution"];
	version: { version_id: string; short_version: string; message: string } | null;
	published_revision: string;
	working_revision: string;
	working_tree_changed: boolean;
}

export interface DirectoryProjectMutationLease {
	release(): Promise<void>;
}

export type ProjectBuildResolver = (buildPath: string) => Promise<LoadedProjectConfig>;

export async function resolveDirectoryProjectRoot(input = "."): Promise<string> {
	const root = resolve(input);
	const details = await stat(root).catch(() => null);
	if (!details?.isDirectory()) throw new UserError(`Project directory does not exist: ${root}`);
	return root;
}

export async function inspectDirectoryProject(projectDirectory = "."): Promise<DirectoryProjectInspection> {
	const projectRoot = await resolveDirectoryProjectRoot(projectDirectory);
	const sourceFiles = await scanProjectSource(projectRoot);
	const projectRevision = hashFiles(sourceFiles);
	const diagnostics: Diagnostic[] = [];
	const warnings: Diagnostic[] = [];
	let assembled: AssembledProject | null = null;
	try {
		assembled = await assembleProject(projectRoot, sourceFiles);
		diagnostics.push(...assembled.diagnostics);
		warnings.push(...assembled.warnings);
	} catch (error) {
		diagnostics.push(toDiagnostic(error));
	}
	return {
		project_root: projectRoot,
		project_revision: projectRevision,
		source_manifest_hash: projectRevision,
		canonical_yaml: assembled?.canonicalYaml ?? "",
		yaml_hash: hash(assembled?.canonicalYaml ?? ""),
		loaded: assembled?.loaded ?? null,
		diagnostics,
		warnings,
		organization_moves: assembled?.moves ?? [],
		source_files: sourceFiles,
	};
}

export async function validateDirectoryProject(projectDirectory = "."): Promise<DirectoryProjectInspection> {
	return inspectDirectoryProject(projectDirectory);
}

export async function resolveDirectoryProjectRuntime(projectDirectory = "."): Promise<LoadedProjectConfig> {
	const inspection = await inspectDirectoryProject(projectDirectory);
	const blockingDiagnostic = inspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (blockingDiagnostic) throw new UserError(blockingDiagnostic.message);
	const rawConfig = parse(inspection.canonical_yaml);
	return resolveProjectConfigFromObject(rawConfig, {
		projectName: basename(inspection.project_root),
		basePath: resolve(inspection.project_root, ".openagentpack/build"),
		resolveEnv: true,
	});
}

export async function getProjectBuildStatus(
	projectDirectory: string,
	inspection?: DirectoryProjectInspection,
): Promise<ProjectBuildStatus> {
	const projectRoot = await resolveDirectoryProjectRoot(projectDirectory);
	const current = inspection ?? (await inspectDirectoryProject(projectRoot));
	let manifest: ProjectBuildManifest;
	try {
		manifest = JSON.parse(await readFile(resolve(projectRoot, PROJECT_BUILD_MANIFEST), "utf8")) as ProjectBuildManifest;
	} catch (error) {
		if (isFsError(error, "ENOENT"))
			return { exists: false, stale: true, manifest: null, reasons: ["Project has not been built."] };
		return { exists: false, stale: true, manifest: null, reasons: ["Build manifest is unreadable."] };
	}
	const reasons: string[] = [];
	if (manifest.project_revision !== current.project_revision)
		reasons.push("Project source changed after the last Build.");
	if (manifest.source_manifest_hash !== current.source_manifest_hash) reasons.push("Project source manifest is stale.");
	const builtYaml = await readFile(resolve(projectRoot, PROJECT_BUILD_FILE), "utf8").catch(() => null);
	if (builtYaml === null) reasons.push("Generated agents.yaml is missing.");
	else if (hash(builtYaml) !== manifest.yaml_hash) reasons.push("Generated agents.yaml does not match its manifest.");
	return { exists: true, stale: reasons.length > 0, manifest, reasons };
}

export async function previewProjectBuild(projectDirectory = "."): Promise<ProjectBuildPreview> {
	const inspection = await inspectDirectoryProject(projectDirectory);
	const buildStatus = await getProjectBuildStatus(inspection.project_root, inspection);
	const beforeYaml = await readFile(resolve(inspection.project_root, PROJECT_BUILD_FILE), "utf8").catch(() => "");
	return {
		...inspection,
		before_yaml: beforeYaml,
		after_yaml: inspection.canonical_yaml,
		build_status: buildStatus,
		can_build: !hasErrors(inspection.diagnostics),
	};
}

export async function commitProjectBuild(input: {
	projectRoot: string;
	baseRevision: string;
}): Promise<ProjectBuildPreview & { manifest: ProjectBuildManifest }> {
	return withProjectMutation(input.projectRoot, "build", async () => {
		const before = await previewProjectBuild(input.projectRoot);
		if (before.project_revision !== input.baseRevision)
			throw new UserError("Project source changed. Preview Build again.");
		if (!before.can_build) throw new UserError("Project contains errors and cannot be built.");
		for (const move of before.organization_moves) await applyOrganizationMove(before.project_root, move);
		const after = await previewProjectBuild(before.project_root);
		if (!after.can_build) throw new UserError("Organized project contains errors and cannot be built.");
		const manifest: ProjectBuildManifest = {
			schema_version: 1,
			project_revision: after.project_revision,
			source_manifest_hash: after.source_manifest_hash,
			yaml_hash: after.yaml_hash,
			built_at: new Date().toISOString(),
		};
		await writeTextAtomic(resolve(after.project_root, PROJECT_BUILD_FILE), after.canonical_yaml, 0o600);
		await writeTextAtomic(
			resolve(after.project_root, PROJECT_BUILD_MANIFEST),
			`${JSON.stringify(manifest, null, 2)}\n`,
			0o600,
		);
		return { ...after, manifest };
	});
}

export async function readValidProjectBuild(projectDirectory = "."): Promise<{
	inspection: DirectoryProjectInspection;
	manifest: ProjectBuildManifest;
	buildPath: string;
	yaml: string;
}> {
	const inspection = await inspectDirectoryProject(projectDirectory);
	if (hasErrors(inspection.diagnostics)) throw new UserError("Project source is invalid. Run project validate.");
	const status = await getProjectBuildStatus(inspection.project_root, inspection);
	if (!status.exists || status.stale || !status.manifest) {
		throw new UserError(
			`Project Build is missing or stale. Run project build first. ${status.reasons.join(" ")}`.trim(),
		);
	}
	const buildPath = resolve(inspection.project_root, PROJECT_BUILD_FILE);
	const yaml = await readFile(buildPath, "utf8");
	return { inspection, manifest: status.manifest, buildPath, yaml };
}

export async function planProjectPublish(
	projectDirectory = ".",
	options: {
		provider?: string;
		refresh?: boolean;
		quiet?: boolean;
		onFeedback?: RuntimeFeedbackSink;
		resolveBuild?: ProjectBuildResolver;
	} = {},
): Promise<ProjectPublishPlan> {
	const build = await readValidProjectBuild(projectDirectory);
	const loaded = await (options.resolveBuild ?? resolveProjectConfig)(build.buildPath);
	const planned = await planProjectWithStateBackend(
		{
			projectName: basename(build.inspection.project_root),
			config: loaded.config,
			configPath: build.buildPath,
			providers: loaded.config.providers,
			stateBackend: new LocalFileStateBackend({
				statePath: resolve(build.inspection.project_root, PROJECT_STATE_FILE),
			}),
			stateScope: { projectId: basename(build.inspection.project_root) },
		},
		options,
	);
	return {
		project_root: build.inspection.project_root,
		project_revision: build.inspection.project_revision,
		build_manifest: build.manifest,
		build_path: build.buildPath,
		planned,
	};
}

export async function executeProjectPublish(input: {
	projectRoot: string;
	expectedProjectRevision: string;
	expectedYamlHash: string;
	provider?: string;
	refresh?: boolean;
	concurrency?: number;
	policy?: "block" | "prompt" | "force";
	confirm?: (actions: PlannedAction[]) => boolean | Promise<boolean>;
	onFeedback?: RuntimeFeedbackSink;
	resolveBuild?: ProjectBuildResolver;
}): Promise<ProjectPublishResult> {
	const versionService = createDirectoryWorkspaceVersionService(input.projectRoot);
	const initial = await readValidProjectBuild(input.projectRoot);
	if (
		initial.inspection.project_revision !== input.expectedProjectRevision ||
		initial.manifest.yaml_hash !== input.expectedYamlHash
	) {
		throw new UserError("Project or Build changed. Plan Publish again.");
	}
	const frozenSnapshot = snapshotFromInspection(initial.inspection);
	const preparedVersion = await versionService.prepareVersion(frozenSnapshot);
	let versionCommitted = false;
	try {
		const checked = await readValidProjectBuild(input.projectRoot);
		if (
			checked.inspection.project_revision !== input.expectedProjectRevision ||
			checked.manifest.yaml_hash !== input.expectedYamlHash
		) {
			throw new UserError("Project or Build changed while Publish was starting.");
		}
		const loaded = await (input.resolveBuild ?? resolveProjectConfig)(checked.buildPath);
		const run = await syncProjectResourcesWithStateBackend(
			{
				projectName: basename(checked.inspection.project_root),
				config: loaded.config,
				configPath: checked.buildPath,
				providers: loaded.config.providers,
				stateBackend: new LocalFileStateBackend({
					statePath: resolve(checked.inspection.project_root, PROJECT_STATE_FILE),
				}),
				stateScope: { projectId: basename(checked.inspection.project_root) },
			},
			{
				provider: input.provider,
				refresh: input.refresh,
				concurrency: input.concurrency,
				policy: input.policy,
				confirm: input.confirm,
				onFeedback: input.onFeedback,
			},
		);
		const incomplete = run.execution?.results.some((result) => result.status !== "success") ?? false;
		if (incomplete) throw new UserError("Publish incomplete: one or more remote actions did not succeed.");
		const version = preparedVersion ? await versionService.commitPrepared(preparedVersion, "Publish project") : null;
		versionCommitted = true;
		const working = await inspectDirectoryProject(input.projectRoot);
		return {
			planned: run.planned,
			execution: run.execution,
			version: version
				? { version_id: version.version_id, short_version: version.short_version, message: version.message }
				: null,
			published_revision: frozenSnapshot.project_revision,
			working_revision: working.project_revision,
			working_tree_changed: working.project_revision !== frozenSnapshot.project_revision,
		};
	} finally {
		if (!versionCommitted) await versionService.releasePrepared(preparedVersion);
	}
}

export async function initializeDirectoryProject(
	input: { projectRoot?: string; provider?: string } = {},
): Promise<InitializedDirectoryProject> {
	const projectRoot = resolve(input.projectRoot ?? ".");
	await mkdir(projectRoot, { recursive: true });
	const initialized = await withProjectMutation(projectRoot, "init", async () => {
		const projectPath = resolve(projectRoot, PROJECT_METADATA_FILE);
		if (await pathExists(projectPath)) throw new UserError(`Directory project already exists: ${projectPath}`);
		const yamlPath = resolve(projectRoot, "agents.yaml");
		let converted = false;
		let stateMigrated = false;
		if (await pathExists(yamlPath)) {
			await convertYamlProject(projectRoot, yamlPath);
			converted = true;
			const oldState = resolve(projectRoot, "agents.state.json");
			if (await pathExists(oldState)) {
				await mkdir(dirname(resolve(projectRoot, PROJECT_STATE_FILE)), { recursive: true });
				await cp(oldState, resolve(projectRoot, PROJECT_STATE_FILE), { force: false });
				stateMigrated = true;
			}
		} else {
			await scaffoldProject(projectRoot, input.provider ?? "bailian");
		}
		return {
			project_root: projectRoot,
			converted_from_yaml: converted,
			state_migrated: stateMigrated,
			baseline_version: null,
		};
	});
	const enabled = await createDirectoryWorkspaceVersionService(projectRoot).enable("Initialize project");
	return { ...initialized, baseline_version: enabled.version?.version_id ?? enabled.versioning.head_version };
}

export function createDirectoryWorkspaceVersionService(projectDirectory: string): DirectoryProjectVersionService {
	const projectRoot = resolve(projectDirectory);
	return createDirectoryProjectVersionService({
		projectRoot,
		adapter: {
			readSnapshot: async () => snapshotFromInspection(await inspectDirectoryProject(projectRoot)),
			restoreSnapshot: async (snapshot, baseRevision) => restoreDirectorySnapshot(projectRoot, snapshot, baseRevision),
		},
	});
}

export async function assertLegacyYamlNotShadowed(configFile: string): Promise<void> {
	const configPath = resolve(configFile);
	if (basename(configPath) !== "agents.yaml") return;
	if (await pathExists(resolve(dirname(configPath), PROJECT_METADATA_FILE))) {
		throw new UserError(
			"This directory is managed as a directory project. Use `agents project build` and `agents project publish`.",
		);
	}
}

interface AssembledProject {
	canonicalYaml: string;
	loaded: LoadedProjectConfig;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
	moves: ProjectOrganizationMove[];
}

interface LocalSkill {
	id: string;
	metadata: Record<string, unknown>;
	location: string;
	relativeDirectory: string;
	rootSkill: boolean;
}

async function assembleProject(projectRoot: string, sourceFiles: ProjectSourceFile[]): Promise<AssembledProject> {
	if (!sourceFiles.some((file) => file.path === PROJECT_METADATA_FILE)) {
		throw new UserError(`Missing ${PROJECT_METADATA_FILE}. Run project init first.`);
	}
	const project = await readJsonObject(resolve(projectRoot, PROJECT_METADATA_FILE));
	if ("agents" in project || "skills" in project) {
		throw new UserError("project.json cannot declare agents or skills; use agents/ and skills/ directories.");
	}
	const projectForBuild = projectWithBuildRelativeFiles(projectRoot, project);
	const agents: Record<string, Record<string, unknown>> = {};
	const agentDirectories = await childDirectories(resolve(projectRoot, "agents"));
	for (const agentId of agentDirectories) {
		const agentDirectory = resolve(projectRoot, "agents", agentId);
		const agentPath = resolve(agentDirectory, "agent.json");
		if (!(await pathExists(agentPath))) continue;
		const agent = await readJsonObject(agentPath);
		if ("id" in agent && agent.id !== agentId)
			throw new UserError(`agents/${agentId}/agent.json: id cannot differ from its directory name.`);
		delete agent.id;
		if ("instructions" in agent)
			throw new UserError(`agents/${agentId}/agent.json: instructions must be stored in instructions.md.`);
		const instructionsPath = resolve(agentDirectory, "instructions.md");
		if (!(await pathExists(instructionsPath))) throw new UserError(`agents/${agentId}/instructions.md is required.`);
		agents[agentId] = {
			...agent,
			instructions: buildRelativePath(`agents/${agentId}/instructions.md`),
		};
	}
	const skills = await discoverSkills(projectRoot, agentDirectories);
	const skillById = new Map<string, LocalSkill>();
	for (const skill of skills) {
		if (skillById.has(skill.id)) throw new UserError(`Duplicate local skill id: ${skill.id}`);
		skillById.set(skill.id, skill);
	}
	const referenceCounts = countSkillReferences(agents, skillById);
	const moves: ProjectOrganizationMove[] = [];
	for (const skill of skills) {
		if (!skill.rootSkill && (referenceCounts.get(skill.id)?.size ?? 0) > 1) {
			moves.push({ skill_id: skill.id, from: skill.relativeDirectory, to: `skills/${skill.id}`, reason: "shared" });
		}
	}
	const warnings: Diagnostic[] = [];
	const declarations: Record<string, Record<string, unknown>> = {};
	for (const skill of skills) {
		const references = referenceCounts.get(skill.id)?.size ?? 0;
		if (references === 0) {
			warnings.push({
				severity: "warning",
				code: "project.skill.unreferenced",
				message: `${skill.location}/skill.json: skill '${skill.id}' is not referenced and is excluded from Build.`,
			});
			continue;
		}
		const finalDirectory = moves.find((move) => move.skill_id === skill.id)?.to ?? skill.relativeDirectory;
		const declaration = { ...skill.metadata };
		delete declaration.id;
		delete declaration.source;
		declarations[skill.id] = { ...declaration, source: buildRelativePath(finalDirectory) };
	}
	const rawConfig = { ...projectForBuild, agents, skills: declarations };
	const loaded = await resolveProjectConfigFromObject(rawConfig, {
		projectName: basename(projectRoot),
		basePath: resolve(projectRoot, ".openagentpack/build"),
	});
	const diagnostics = validateProjectConfig(loaded.config);
	const canonicalYaml = stringify(sortObjectDeep(rawConfig), { lineWidth: 0, sortMapEntries: true });
	return { canonicalYaml, loaded, diagnostics, warnings, moves };
}

function projectWithBuildRelativeFiles(projectRoot: string, project: Record<string, unknown>): Record<string, unknown> {
	const result = structuredClone(project);
	if (!isRecord(result.files)) return result;
	for (const [fileId, value] of Object.entries(result.files)) {
		if (!isRecord(value) || typeof value.source !== "string" || /^https?:\/\//i.test(value.source)) continue;
		if (isAbsolute(value.source)) throw new UserError(`files.${fileId}.source must be relative to the project root.`);
		const sourcePath = resolve(projectRoot, value.source);
		if (sourcePath !== projectRoot && !sourcePath.startsWith(`${projectRoot}${sep}`)) {
			throw new UserError(`files.${fileId}.source escapes the project root.`);
		}
		const projectRelative = relative(projectRoot, sourcePath).split(sep).join("/");
		value.source = buildRelativePath(projectRelative);
	}
	return result;
}

async function discoverSkills(projectRoot: string, agentDirectories: string[]): Promise<LocalSkill[]> {
	const locations: Array<{ path: string; relativeDirectory: string; rootSkill: boolean }> = [];
	for (const skillDirectory of await childDirectories(resolve(projectRoot, "skills"))) {
		locations.push({
			path: resolve(projectRoot, "skills", skillDirectory),
			relativeDirectory: `skills/${skillDirectory}`,
			rootSkill: true,
		});
	}
	for (const agentId of agentDirectories) {
		for (const skillDirectory of await childDirectories(resolve(projectRoot, "agents", agentId, "skills"))) {
			locations.push({
				path: resolve(projectRoot, "agents", agentId, "skills", skillDirectory),
				relativeDirectory: `agents/${agentId}/skills/${skillDirectory}`,
				rootSkill: false,
			});
		}
	}
	const result: LocalSkill[] = [];
	for (const location of locations) {
		const metadataPath = resolve(location.path, "skill.json");
		if (!(await pathExists(metadataPath))) continue;
		const metadata = await readJsonObject(metadataPath);
		if (typeof metadata.id !== "string" || !metadata.id.trim())
			throw new UserError(`${relative(projectRoot, metadataPath)}: id is required.`);
		if (!(await pathExists(resolve(location.path, "SKILL.md"))))
			throw new UserError(`${location.relativeDirectory}/SKILL.md is required.`);
		result.push({
			id: metadata.id,
			metadata,
			location: location.relativeDirectory,
			relativeDirectory: location.relativeDirectory,
			rootSkill: location.rootSkill,
		});
	}
	return result;
}

function countSkillReferences(
	agents: Record<string, Record<string, unknown>>,
	skills: Map<string, LocalSkill>,
): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const [agentId, agent] of Object.entries(agents)) {
		const refs = Array.isArray(agent.skills) ? agent.skills : [];
		for (const ref of refs) {
			const id =
				typeof ref === "string" ? ref : isRecord(ref) && typeof ref.skill_id === "string" ? ref.skill_id : null;
			if (!id || !skills.has(id)) continue;
			const agentsForSkill = result.get(id) ?? new Set<string>();
			agentsForSkill.add(agentId);
			result.set(id, agentsForSkill);
		}
	}
	return result;
}

async function scanProjectSource(projectRoot: string): Promise<ProjectSourceFile[]> {
	const rootReal = await realpath(projectRoot);
	const files: ProjectSourceFile[] = [];
	async function walk(directory: string, relativeDirectory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!relativeDirectory && IGNORED_ROOT_NAMES.has(entry.name)) continue;
			const absolute = resolve(directory, entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const details = await lstat(absolute);
			if (details.isSymbolicLink()) {
				const target = await realpath(absolute);
				if (target !== rootReal && !target.startsWith(`${rootReal}${sep}`))
					throw new UserError(`${relativePath}: symlink escapes the project root.`);
				throw new UserError(`${relativePath}: symlinks are not supported in directory projects.`);
			}
			if (details.isDirectory()) await walk(absolute, relativePath);
			else if (details.isFile())
				files.push({
					path: relativePath,
					mode: details.mode & 0o777,
					content: new Uint8Array(await readFile(absolute)),
				});
		}
	}
	await walk(projectRoot, "");
	return files;
}

async function restoreDirectorySnapshot(
	projectRoot: string,
	snapshot: DirectoryProjectSnapshot,
	baseRevision: string,
): Promise<void> {
	const current = await inspectDirectoryProject(projectRoot);
	if (current.project_revision !== baseRevision) throw new UserError("Project source changed before Restore.");
	const staging = resolve(projectRoot, PROJECT_INTERNAL_DIRECTORY, `restore-${randomUUID()}`);
	await mkdir(staging, { recursive: true });
	try {
		for (const file of snapshot.files) {
			assertSafeRelative(file.path);
			const destination = resolve(staging, file.path);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, file.content, { mode: file.mode });
		}
		const currentPaths = new Set(current.source_files.map((file) => file.path));
		const historicalPaths = new Set(snapshot.files.map((file) => file.path));
		for (const path of currentPaths)
			if (!historicalPaths.has(path)) await rm(resolve(projectRoot, path), { force: true });
		for (const file of snapshot.files) {
			const source = resolve(staging, file.path);
			const destination = resolve(projectRoot, file.path);
			await mkdir(dirname(destination), { recursive: true });
			await rename(source, destination);
			await chmod(destination, file.mode);
		}
		await rm(resolve(projectRoot, ".openagentpack/build"), { recursive: true, force: true });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

function snapshotFromInspection(inspection: DirectoryProjectInspection): DirectoryProjectSnapshot {
	return {
		project_revision: inspection.project_revision,
		canonical_yaml: inspection.canonical_yaml,
		files: inspection.source_files.map((file) => ({ ...file })),
	};
}

async function applyOrganizationMove(projectRoot: string, move: ProjectOrganizationMove): Promise<void> {
	const source = resolve(projectRoot, move.from);
	const destination = resolve(projectRoot, move.to);
	if (await pathExists(destination))
		throw new UserError(`Cannot move shared skill '${move.skill_id}': ${move.to} already exists.`);
	await mkdir(dirname(destination), { recursive: true });
	await rename(source, destination);
}

async function scaffoldProject(projectRoot: string, provider: string): Promise<void> {
	const providerTemplates: Record<string, { config: Record<string, string>; model: string }> = {
		bailian: {
			config: { api_key: `\${DASHSCOPE_API_KEY}`, workspace_id: `\${BAILIAN_WORKSPACE_ID}` },
			model: "qwen3.7-max",
		},
		claude: { config: { api_key: `\${ANTHROPIC_API_KEY}` }, model: "claude-sonnet-4-6" },
		qoder: {
			config: { api_key: `\${QODER_PAT}`, gateway: "https://api.qoder.com/api/v1/cloud" },
			model: "ultimate",
		},
		ark: { config: { api_key: `\${ARK_API_KEY}` }, model: "doubao-seed-2-1-pro-260628" },
	};
	const template = providerTemplates[provider];
	if (!template) throw new UserError(`Unsupported provider '${provider}'.`);
	const project = { version: "1", providers: { [provider]: template.config }, defaults: { provider } };
	const agentDirectory = resolve(projectRoot, "agents", "assistant");
	await mkdir(agentDirectory, { recursive: true });
	await writeTextAtomic(resolve(projectRoot, PROJECT_METADATA_FILE), `${JSON.stringify(project, null, 2)}\n`);
	await writeTextAtomic(
		resolve(agentDirectory, "agent.json"),
		`${JSON.stringify({ name: "Assistant", model: template.model }, null, 2)}\n`,
	);
	await writeTextAtomic(resolve(agentDirectory, "instructions.md"), "You are a helpful assistant.\n");
}

async function convertYamlProject(projectRoot: string, yamlPath: string): Promise<void> {
	const source = await readFile(yamlPath, "utf8");
	const inspection = await inspectProjectSource(source, yamlPath);
	const blockingDiagnostic = inspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (blockingDiagnostic) throw new UserError(blockingDiagnostic.message);
	const raw = parse(source) as Record<string, unknown>;
	if (!isRecord(raw)) throw new UserError("agents.yaml must contain an object.");
	const agents = isRecord(raw.agents) ? raw.agents : {};
	const skills = isRecord(raw.skills) ? raw.skills : {};
	const project = { ...raw };
	delete project.agents;
	delete project.skills;
	await writeTextAtomic(resolve(projectRoot, PROJECT_METADATA_FILE), `${JSON.stringify(project, null, 2)}\n`);
	const references = new Map<string, Set<string>>();
	for (const [agentId, value] of Object.entries(agents)) {
		if (!isRecord(value)) throw new UserError(`agents.${agentId} must be an object.`);
		const agent = { ...value };
		const instructions = await materializeText(projectRoot, agent.instructions, "You are a helpful assistant.\n");
		delete agent.instructions;
		for (const ref of Array.isArray(agent.skills) ? agent.skills : []) {
			const skillId =
				typeof ref === "string" ? ref : isRecord(ref) && typeof ref.skill_id === "string" ? ref.skill_id : null;
			if (!skillId) continue;
			const set = references.get(skillId) ?? new Set<string>();
			set.add(agentId);
			references.set(skillId, set);
		}
		const directory = resolve(projectRoot, "agents", agentId);
		await mkdir(directory, { recursive: true });
		await writeTextAtomic(resolve(directory, "agent.json"), `${JSON.stringify(agent, null, 2)}\n`);
		await writeTextAtomic(resolve(directory, "instructions.md"), instructions);
	}
	for (const [skillId, value] of Object.entries(skills)) {
		if (!isRecord(value)) throw new UserError(`skills.${skillId} must be an object.`);
		const owners = references.get(skillId) ?? new Set<string>();
		const relativeDirectory = owners.size === 1 ? `agents/${[...owners][0]}/skills/${skillId}` : `skills/${skillId}`;
		const destination = resolve(projectRoot, relativeDirectory);
		await mkdir(destination, { recursive: true });
		const metadata: Record<string, unknown> = { id: skillId, ...value };
		delete metadata.source;
		await writeTextAtomic(resolve(destination, "skill.json"), `${JSON.stringify(metadata, null, 2)}\n`);
		await materializeSkillSource(projectRoot, value.source, destination);
	}
}

async function materializeText(projectRoot: string, value: unknown, fallback: string): Promise<string> {
	if (typeof value !== "string") return fallback;
	if (value.startsWith("./") || value.startsWith("../") || isAbsolute(value)) {
		return readFile(resolve(projectRoot, value), "utf8");
	}
	return value.endsWith("\n") ? value : `${value}\n`;
}

async function materializeSkillSource(projectRoot: string, source: unknown, destination: string): Promise<void> {
	if (typeof source !== "string" || /^https?:\/\//i.test(source)) {
		await writeTextAtomic(resolve(destination, "SKILL.md"), "# Skill\n");
		return;
	}
	const sourcePath = resolve(projectRoot, source);
	const details = await stat(sourcePath);
	if (details.isDirectory()) {
		if (sourcePath === destination) return;
		for (const entry of await readdir(sourcePath)) {
			if (entry === "skill.json") continue;
			await cp(resolve(sourcePath, entry), resolve(destination, entry), { recursive: true, errorOnExist: true });
		}
	} else {
		await cp(sourcePath, resolve(destination, "SKILL.md"), { errorOnExist: true });
	}
}

async function childDirectories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (isFsError(error, "ENOENT")) return [];
		throw error;
	}
}

function buildRelativePath(projectRelativePath: string): string {
	return `../../${projectRelativePath}`;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new UserError(`${relative(process.cwd(), path)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new UserError(`${path}: expected a JSON object.`);
	return parsed;
}

async function withProjectMutation<Result>(
	projectDirectory: string,
	kind: string,
	action: () => Promise<Result>,
): Promise<Result> {
	const lease = await acquireDirectoryProjectMutation(projectDirectory, kind);
	try {
		return await action();
	} finally {
		await lease.release();
	}
}

export async function acquireDirectoryProjectMutation(
	projectDirectory: string,
	kind: string,
): Promise<DirectoryProjectMutationLease> {
	const projectRoot = resolve(projectDirectory);
	const lockDirectory = resolve(projectRoot, PROJECT_INTERNAL_DIRECTORY, "mutation.lock");
	await mkdir(dirname(lockDirectory), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await mkdir(lockDirectory);
			break;
		} catch (error) {
			if (!isFsError(error, "EEXIST")) throw error;
			if (attempt === 0 && (await recoverDeadProjectMutation(lockDirectory))) continue;
			throw new DirectoryProjectMutationConflictError(
				"Project is busy with another Build, Publish, Restore, or Workbench write.",
			);
		}
	}
	await writeFile(
		resolve(lockDirectory, "lease.json"),
		`${JSON.stringify({ pid: process.pid, kind, created_at: new Date().toISOString() })}\n`,
	);
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			await rm(lockDirectory, { recursive: true, force: true });
		},
	};
}

async function recoverDeadProjectMutation(lockDirectory: string): Promise<boolean> {
	let pid: number;
	try {
		const value = JSON.parse(await readFile(resolve(lockDirectory, "lease.json"), "utf8")) as { pid?: unknown };
		if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return false;
		pid = value.pid;
	} catch {
		return false;
	}
	if (isProcessAlive(pid)) return false;
	const stale = `${lockDirectory}.stale.${randomUUID()}`;
	try {
		await rename(lockDirectory, stale);
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

async function writeTextAtomic(path: string, source: string, mode = 0o644): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, source, { mode });
	await rename(temporary, path);
}

function hashFiles(files: ProjectSourceFile[]): string {
	const digest = createHash("sha256");
	for (const file of files)
		digest.update(file.path).update("\0").update(String(file.mode)).update("\0").update(file.content).update("\0");
	return digest.digest("hex");
}

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortObjectDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObjectDeep);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortObjectDeep(value[key])]),
	);
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function toDiagnostic(error: unknown): Diagnostic {
	return {
		severity: "error",
		code: "project.directory.invalid",
		message: error instanceof Error ? error.message : String(error),
	};
}

function assertSafeRelative(path: string): void {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new UserError(`Invalid project snapshot path: ${path}`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isFsError(error, "ENOENT")) return false;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsError(error: unknown, code: string): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === code;
}

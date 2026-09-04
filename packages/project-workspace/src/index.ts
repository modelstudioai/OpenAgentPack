import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
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
	executePlannedProject,
	inspectProjectSource,
	planProjectContext,
	planProjectWithStateBackend,
	resolveProjectConfigFromObject,
	resolveProjectConfig,
	UserError,
	validateProjectConfig,
	writeProjectRuntime,
} from "@openagentpack/sdk";
import { parse, stringify } from "yaml";
import { directoryProjectScaffold, RESOURCE_EXAMPLES_DIRECTORY } from "./scaffold.ts";
import {
	applyVaultSecretMigration,
	planVaultSecretMigration,
	readProjectEnvironment,
	redactVaultText,
} from "./vault-secrets.ts";

export const PROJECT_METADATA_FILE = "project.json";
export const PROJECT_INTERNAL_DIRECTORY = ".openagentpack";
export const PROJECT_BUILD_FILE = ".openagentpack/build/agents.yaml";
export const PROJECT_BUILD_MANIFEST = ".openagentpack/build/manifest.json";
export const PROJECT_STATE_FILE = ".openagentpack/state.json";
export const FILE_AUTO_ASSOCIATION_IGNORE_FILE = ".openagentpack-ignore";

const DIRECTORY_PROJECT_PROVIDER = "bailian";
const DIRECTORY_PROJECT_PROVIDER_CONFIG = {
	api_key: `\${DASHSCOPE_API_KEY}`,
	base_url: `\${BAILIAN_BASE_URL}`,
};

export const DIRECTORY_RESOURCE_TYPES = ["environment", "vault", "memory_store", "file"] as const;
export type DirectoryResourceType = (typeof DIRECTORY_RESOURCE_TYPES)[number];

const DIRECTORY_RESOURCE_SPECS: Record<
	DirectoryResourceType,
	{ section: "environments" | "vaults" | "memory_stores" | "files"; directory: string; metadataFile: string }
> = {
	environment: { section: "environments", directory: "environments", metadataFile: "environment.json" },
	vault: { section: "vaults", directory: "vaults", metadataFile: "vault.json" },
	memory_store: { section: "memory_stores", directory: "memory-stores", metadataFile: "memory-store.json" },
	file: { section: "files", directory: "files", metadataFile: "file.json" },
};

const IGNORED_ROOT_NAMES = new Set([
	".git",
	".openagentpack",
	"agents.yaml",
	"agents.state.json",
	"node_modules",
	"dist",
	"build",
	".cache",
	".DS_Store",
]);
const IGNORED_SOURCE_NAMES = new Set([".env"]);

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
	resource_type: "skill" | DirectoryResourceType;
	resource_id: string;
	from: string;
	to: string;
	reason: "shared";
}

export interface DirectoryResourceSource {
	type: DirectoryResourceType;
	id: string;
	path: string;
	directory: string;
	relative_directory: string;
	owner_agent?: string;
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
	plan_fingerprint: string;
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

export type ProjectBuildResolver = (
	buildPath: string,
	options?: { environment?: Record<string, string> },
) => Promise<LoadedProjectConfig>;

export async function resolveDirectoryProjectRoot(input = "."): Promise<string> {
	const root = resolve(input);
	const details = await stat(root).catch(() => null);
	if (!details?.isDirectory()) throw new UserError(`Project directory does not exist: ${root}`);
	return root;
}

export async function inspectDirectoryProject(projectDirectory = "."): Promise<DirectoryProjectInspection> {
	const projectRoot = await resolveDirectoryProjectRoot(projectDirectory);
	const sourceFiles = await scanProjectSource(projectRoot);
	return inspectSourceFiles(projectRoot, sourceFiles);
}

async function inspectSourceFiles(
	projectRoot: string,
	sourceFiles: ProjectSourceFile[],
	metadataOverrides?: Map<string, Record<string, unknown>>,
): Promise<DirectoryProjectInspection> {
	const projectRevision = hashFiles(sourceFiles);
	const diagnostics: Diagnostic[] = [];
	const warnings: Diagnostic[] = [];
	let assembled: AssembledProject | null = null;
	try {
		assembled = await assembleProject(projectRoot, sourceFiles, metadataOverrides);
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
		environment: await readProjectEnvironment(inspection.project_root),
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
	const projectRoot = await resolveDirectoryProjectRoot(projectDirectory);
	const sourceFiles = await scanProjectSource(projectRoot);
	let migration: Awaited<ReturnType<typeof planVaultSecretMigration>> | undefined;
	let migrationError: Diagnostic | undefined;
	try {
		migration = await planVaultSecretMigration(projectRoot, sourceFiles);
	} catch (error) {
		migrationError = toDiagnostic(error);
	}
	const inspection = await inspectSourceFiles(projectRoot, sourceFiles, migration?.overrides);
	const literals = migration?.literals ?? [];
	if (migrationError) {
		inspection.diagnostics = [migrationError];
		inspection.canonical_yaml = "# Vault migration could not be previewed safely.\n";
	} else if (migration?.count) {
		inspection.warnings.push({
			severity: "warning",
			code: "project.vault.secrets.externalized",
			message: `${migration.count} Vault secret(s) will move to project .env; vault.json will use environment references. / ${migration.count} 个 Vault 密钥将移入项目 .env，vault.json 将改用环境变量引用。`,
		});
	}
	inspection.loaded = null;
	inspection.diagnostics = inspection.diagnostics.map((diagnostic) => ({
		...diagnostic,
		message: redactVaultText(diagnostic.message, literals),
	}));
	inspection.warnings = inspection.warnings.map((diagnostic) => ({
		...diagnostic,
		message: redactVaultText(diagnostic.message, literals),
	}));
	// Preview carries display copies only. Revision checks and version snapshots
	// always rescan the original source, never these normalized/redacted copies.
	inspection.source_files = sourceFiles.map((file) => {
		if (hasErrors(inspection.diagnostics) && file.path.endsWith("/vault.json"))
			return { ...file, content: Buffer.from("[omitted]") };
		const normalized = migration?.overrides.get(file.path);
		if (normalized) return { ...file, content: Buffer.from(JSON.stringify(normalized, null, 2)) };
		if (!literals.some((literal) => Buffer.from(file.content).includes(literal))) return file;
		return { ...file, content: Buffer.from("[omitted: contains a Vault secret]") };
	});
	const buildStatus = await getProjectBuildStatus(inspection.project_root, inspection);
	const beforeYaml = await readFile(resolve(inspection.project_root, PROJECT_BUILD_FILE), "utf8").catch(() => "");
	const safeBefore = await inspectProjectSource(beforeYaml, resolve(projectRoot, PROJECT_BUILD_FILE));
	return {
		...inspection,
		before_yaml: safeBefore.redacted_source,
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
		const sourceFiles = await scanProjectSource(before.project_root);
		if (hashFiles(sourceFiles) !== input.baseRevision)
			throw new UserError("Project source changed. Preview Build again.");
		const migration = await planVaultSecretMigration(before.project_root, sourceFiles);
		const assembled = await assembleProject(before.project_root, sourceFiles, migration.overrides);
		if (hasErrors(assembled.diagnostics)) throw new UserError("Project contains errors and cannot be built.");
		await applyVaultSecretMigration(before.project_root, sourceFiles, migration);
		await applyProjectAutoAssociations(before.project_root, assembled.autoAssociations);
		for (const move of before.organization_moves) await applyOrganizationMove(before.project_root, move);
		const after = await previewProjectBuild(before.project_root);
		if (!after.can_build) throw new UserError("Organized project contains errors and cannot be built.");
		const materialized = await inspectDirectoryProject(before.project_root);
		if (materialized.project_revision !== after.project_revision || materialized.yaml_hash !== after.yaml_hash) {
			throw new UserError("Project source changed during Build. Preview Build again.");
		}
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
	const loaded = await (options.resolveBuild ?? resolveProjectConfig)(build.buildPath, {
		environment: await readProjectEnvironment(build.inspection.project_root),
	});
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
		plan_fingerprint: projectPublishPlanFingerprint(planned),
		planned,
	};
}

export async function executeProjectPublish(input: {
	projectRoot: string;
	expectedProjectRevision: string;
	expectedYamlHash: string;
	expectedPlanFingerprint: string;
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
		const loaded = await (input.resolveBuild ?? resolveProjectConfig)(checked.buildPath, {
			environment: await readProjectEnvironment(checked.inspection.project_root),
		});
		const run = await writeProjectRuntime(
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
			async (context) => {
				const planned = await planProjectContext(context, {
					provider: input.provider,
					refresh: input.refresh,
					onFeedback: input.onFeedback,
				});
				if (projectPublishPlanFingerprint(planned) !== input.expectedPlanFingerprint) {
					throw new UserError("Project, remote resources, or Publish plan changed. Plan Publish again.");
				}
				return {
					planned,
					execution: await executePlannedProject(planned, {
						concurrency: input.concurrency,
						policy: input.policy,
						confirm: input.confirm,
						onFeedback: input.onFeedback,
					}),
				};
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
	input: { projectRoot?: string } = {},
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
			await scaffoldProject(projectRoot);
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
	autoAssociations: ProjectAutoAssociationPlan;
}

interface LocalSkill {
	id: string;
	metadata: Record<string, unknown>;
	location: string;
	relativeDirectory: string;
	rootSkill: boolean;
	ownerAgent?: string;
	inferred?: boolean;
}

interface LocalDirectoryResource extends DirectoryResourceSource {
	metadata: Record<string, unknown>;
	inferred?: boolean;
}

interface ProjectAutoAssociationPlan {
	fileMoves: Array<{ from: string; to: string }>;
	jsonWrites: Map<string, Record<string, unknown>>;
	warnings: Diagnostic[];
}

async function assembleProject(
	projectRoot: string,
	sourceFiles: ProjectSourceFile[],
	metadataOverrides?: Map<string, Record<string, unknown>>,
): Promise<AssembledProject> {
	if (!sourceFiles.some((file) => file.path === PROJECT_METADATA_FILE)) {
		throw new UserError(`Missing ${PROJECT_METADATA_FILE}. Run project init first.`);
	}
	const project = await readJsonObject(resolve(projectRoot, PROJECT_METADATA_FILE));
	if ("providers" in project || (isRecord(project.defaults) && "provider" in project.defaults)) {
		throw new UserError(
			`project.json cannot declare providers or defaults.provider; directory projects use '${DIRECTORY_PROJECT_PROVIDER}' automatically.`,
		);
	}
	if ("defaults" in project && !isRecord(project.defaults)) {
		throw new UserError("project.json defaults must be an object.");
	}
	const directorySections = [
		"agents",
		"skills",
		...DIRECTORY_RESOURCE_TYPES.map((type) => DIRECTORY_RESOURCE_SPECS[type].section),
	];
	const misplacedSections = directorySections.filter((section) => section in project);
	if (misplacedSections.length > 0) {
		throw new UserError(
			`project.json cannot declare ${misplacedSections.join(", ")}; use agents/ and Agent-local or resources/ directories.`,
		);
	}
	const agents: Record<string, Record<string, unknown>> = {};
	const agentSources = new Map<string, Record<string, unknown>>();
	const autoAssociations: ProjectAutoAssociationPlan = {
		fileMoves: [],
		jsonWrites: new Map(),
		warnings: [],
	};
	const agentDirectories = await childDirectories(resolve(projectRoot, "agents"));
	for (const agentId of agentDirectories) {
		const agentDirectory = resolve(projectRoot, "agents", agentId);
		const agentPath = resolve(agentDirectory, "agent.json");
		if (!(await pathExists(agentPath))) continue;
		const agentSource = await readJsonObject(agentPath);
		agentSources.set(agentId, agentSource);
		const agent = structuredClone(agentSource);
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
	const skills = await discoverSkills(projectRoot, agentDirectories, autoAssociations);
	const skillById = new Map<string, LocalSkill>();
	for (const skill of skills) {
		if (skillById.has(skill.id)) throw new UserError(`Duplicate local skill id: ${skill.id}`);
		skillById.set(skill.id, skill);
		if (skill.ownerAgent && skill.inferred) {
			autoAssociateSkill(skill, projectRoot, agents, agentSources, autoAssociations);
		}
	}
	const referenceCounts = countSkillReferences(agents, skillById);
	const moves: ProjectOrganizationMove[] = [];
	for (const skill of skills) {
		if (!skill.rootSkill && (referenceCounts.get(skill.id)?.size ?? 0) > 1) {
			moves.push({
				resource_type: "skill",
				resource_id: skill.id,
				from: skill.relativeDirectory,
				to: `skills/${skill.id}`,
				reason: "shared",
			});
		}
	}
	const warnings: Diagnostic[] = autoAssociations.warnings;
	const skillDeclarations: Record<string, Record<string, unknown>> = {};
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
		const finalDirectory =
			moves.find((move) => move.resource_type === "skill" && move.resource_id === skill.id)?.to ??
			skill.relativeDirectory;
		const declaration = { ...skill.metadata };
		delete declaration.id;
		delete declaration.source;
		skillDeclarations[skill.id] = { ...declaration, source: buildRelativePath(finalDirectory) };
	}
	const resources = await discoverDirectoryResources(
		projectRoot,
		agentDirectories,
		autoAssociations,
		metadataOverrides,
	);
	const resourceKeys = new Set<string>();
	for (const resource of resources) {
		const key = `${resource.type}:${resource.id}`;
		if (resourceKeys.has(key)) throw new UserError(`Duplicate ${resource.type} id: ${resource.id}`);
		resourceKeys.add(key);
		if (resource.type === "file" && resource.owner_agent && resource.inferred) {
			autoAssociateFile(resource, projectRoot, agents, agentSources, autoAssociations);
		}
		if (
			resource.owner_agent &&
			isDirectoryResourceShared(resource.type, resource.id, resource.owner_agent, agents, project)
		) {
			const spec = DIRECTORY_RESOURCE_SPECS[resource.type];
			moves.push({
				resource_type: resource.type,
				resource_id: resource.id,
				from: resource.relative_directory,
				to: `resources/${spec.directory}/${resource.id}`,
				reason: "shared",
			});
		}
	}
	const rawConfig: Record<string, unknown> = {
		...project,
		providers: { [DIRECTORY_PROJECT_PROVIDER]: DIRECTORY_PROJECT_PROVIDER_CONFIG },
		defaults: { ...(isRecord(project.defaults) ? project.defaults : {}), provider: DIRECTORY_PROJECT_PROVIDER },
		agents,
		skills: skillDeclarations,
	};
	for (const type of DIRECTORY_RESOURCE_TYPES) {
		const declarations: Record<string, Record<string, unknown>> = {};
		for (const resource of resources.filter((candidate) => candidate.type === type)) {
			const finalDirectory =
				moves.find((move) => move.resource_type === type && move.resource_id === resource.id)?.to ??
				resource.relative_directory;
			declarations[resource.id] = directoryResourceDeclarationForBuild(projectRoot, resource, finalDirectory);
		}
		if (Object.keys(declarations).length > 0) rawConfig[DIRECTORY_RESOURCE_SPECS[type].section] = declarations;
	}
	const loaded = await resolveProjectConfigFromObject(rawConfig, {
		projectName: basename(projectRoot),
		basePath: resolve(projectRoot, ".openagentpack/build"),
	});
	const diagnostics = validateProjectConfig(loaded.config);
	const canonicalYaml = stringify(sortObjectDeep(rawConfig), { lineWidth: 0, sortMapEntries: true });
	return { canonicalYaml, loaded, diagnostics, warnings, moves, autoAssociations };
}

function directoryResourceDeclarationForBuild(
	projectRoot: string,
	resource: LocalDirectoryResource,
	finalDirectory: string,
): Record<string, unknown> {
	const declaration = structuredClone(resource.metadata);
	delete declaration.id;
	if (resource.type !== "file" || typeof declaration.source !== "string" || /^https?:\/\//i.test(declaration.source)) {
		return declaration;
	}
	if (isAbsolute(declaration.source)) {
		throw new UserError(`${resource.relative_directory}/file.json: source must be relative to the File directory.`);
	}
	const sourcePath = resolve(resource.directory, declaration.source);
	if (!isPathInside(projectRoot, sourcePath)) {
		throw new UserError(`${resource.relative_directory}/file.json: source escapes the project root.`);
	}
	const sourceRelativeToResource = relative(resource.directory, sourcePath);
	const finalSourcePath = resolve(projectRoot, finalDirectory, sourceRelativeToResource);
	const projectRelative = relative(projectRoot, finalSourcePath).split(sep).join("/");
	declaration.source = buildRelativePath(projectRelative);
	return declaration;
}

export async function locateDirectoryProjectResource(
	projectDirectory: string,
	type: DirectoryResourceType,
	id: string,
): Promise<DirectoryResourceSource | null> {
	const projectRoot = await resolveDirectoryProjectRoot(projectDirectory);
	const resources = await discoverDirectoryResources(
		projectRoot,
		await childDirectories(resolve(projectRoot, "agents")),
	);
	const matches = resources.filter((resource) => resource.type === type && resource.id === id);
	if (matches.length > 1) throw new UserError(`Duplicate ${type} id: ${id}`);
	const match = matches[0];
	if (!match) return null;
	const { metadata: _metadata, ...source } = match;
	return source;
}

async function discoverDirectoryResources(
	projectRoot: string,
	agentDirectories: string[],
	autoAssociations: ProjectAutoAssociationPlan = createProjectAutoAssociationPlan(),
	metadataOverrides?: Map<string, Record<string, unknown>>,
): Promise<LocalDirectoryResource[]> {
	const locations: Array<{
		type: DirectoryResourceType;
		id: string;
		directory: string;
		relativeDirectory: string;
		ownerAgent?: string;
	}> = [];
	for (const type of DIRECTORY_RESOURCE_TYPES) {
		const spec = DIRECTORY_RESOURCE_SPECS[type];
		for (const resourceId of await resourceDirectories(resolve(projectRoot, "resources", spec.directory))) {
			locations.push({
				type,
				id: resourceId,
				directory: resolve(projectRoot, "resources", spec.directory, resourceId),
				relativeDirectory: `resources/${spec.directory}/${resourceId}`,
			});
		}
		for (const agentId of agentDirectories) {
			for (const resourceId of await resourceDirectories(resolve(projectRoot, "agents", agentId, spec.directory))) {
				locations.push({
					type,
					id: resourceId,
					directory: resolve(projectRoot, "agents", agentId, spec.directory, resourceId),
					relativeDirectory: `agents/${agentId}/${spec.directory}/${resourceId}`,
					ownerAgent: agentId,
				});
			}
		}
	}
	const resources: LocalDirectoryResource[] = [];
	for (const location of locations) {
		const metadataFile = DIRECTORY_RESOURCE_SPECS[location.type].metadataFile;
		const metadataPath = resolve(location.directory, metadataFile);
		let metadata: Record<string, unknown>;
		let inferred = false;
		if (await pathExists(metadataPath)) {
			metadata =
				metadataOverrides?.get(`${location.relativeDirectory}/${metadataFile}`) ?? (await readJsonObject(metadataPath));
		} else if (location.type === "file" && location.ownerAgent) {
			if (await pathExists(resolve(location.directory, FILE_AUTO_ASSOCIATION_IGNORE_FILE))) continue;
			const fileNames = await directProjectFiles(location.directory);
			if (fileNames.length === 0) continue;
			if (fileNames.length > 1) {
				throw new UserError(
					`${location.relativeDirectory}/file.json is required when a File directory contains multiple files.`,
				);
			}
			const [fileName] = fileNames;
			metadata = { id: location.id, name: fileName, source: `./${fileName}` };
			inferred = true;
			planJsonWrite(autoAssociations, projectRoot, metadataPath, metadata);
			autoAssociations.warnings.push({
				severity: "warning",
				code: "project.file.metadata.inferred",
				message: `${location.relativeDirectory}/${fileName} will become File '${location.id}'.`,
			});
		} else {
			if (location.type === "file") continue;
			throw new UserError(`${location.relativeDirectory}/${metadataFile} is required.`);
		}
		if (metadata.id !== location.id) {
			throw new UserError(`${location.relativeDirectory}/${metadataFile}: id must be '${location.id}'.`);
		}
		resources.push({
			type: location.type,
			id: location.id,
			path: metadataPath,
			directory: location.directory,
			relative_directory: location.relativeDirectory,
			...(location.ownerAgent ? { owner_agent: location.ownerAgent } : {}),
			metadata,
			...(inferred ? { inferred: true } : {}),
		});
	}
	for (const agentId of agentDirectories) {
		const filesDirectory = resolve(projectRoot, "agents", agentId, DIRECTORY_RESOURCE_SPECS.file.directory);
		for (const fileName of await directProjectFiles(filesDirectory)) {
			const resourceId = inferFileResourceId(fileName);
			const relativeDirectory = `agents/${agentId}/files/${resourceId}`;
			const destinationDirectory = resolve(projectRoot, relativeDirectory);
			const metadata = { id: resourceId, name: fileName, source: `./${fileName}` };
			resources.push({
				type: "file",
				id: resourceId,
				path: resolve(destinationDirectory, "file.json"),
				directory: filesDirectory,
				relative_directory: relativeDirectory,
				owner_agent: agentId,
				metadata,
				inferred: true,
			});
			autoAssociations.fileMoves.push({
				from: `agents/${agentId}/files/${fileName}`,
				to: `${relativeDirectory}/${fileName}`,
			});
			planJsonWrite(autoAssociations, projectRoot, resolve(destinationDirectory, "file.json"), metadata);
			autoAssociations.warnings.push({
				severity: "warning",
				code: "project.file.discovered",
				message: `agents/${agentId}/files/${fileName} will become File '${resourceId}' and be linked to Agent '${agentId}'.`,
			});
		}
	}
	return resources;
}

function isDirectoryResourceShared(
	type: DirectoryResourceType,
	id: string,
	ownerAgent: string,
	agents: Record<string, Record<string, unknown>>,
	project: Record<string, unknown>,
): boolean {
	for (const [agentId, agent] of Object.entries(agents)) {
		if (agentId !== ownerAgent && agentReferencesDirectoryResource(agent, type, id)) return true;
	}
	const deployments = isRecord(project.deployments) ? project.deployments : {};
	for (const deployment of Object.values(deployments)) {
		if (isRecord(deployment) && deploymentReferencesDirectoryResource(deployment, type, id)) return true;
	}
	return false;
}

function agentReferencesDirectoryResource(
	agent: Record<string, unknown>,
	type: DirectoryResourceType,
	id: string,
): boolean {
	if (type === "environment") return agent.environment === id;
	if (type === "vault") return agent.vault === id;
	if (type === "memory_store") return Array.isArray(agent.memory_stores) && agent.memory_stores.includes(id);
	if (type === "file") {
		return Array.isArray(agent.files) && agent.files.some((file) => isRecord(file) && file.file === id);
	}
	return false;
}

function deploymentReferencesDirectoryResource(
	deployment: Record<string, unknown>,
	type: DirectoryResourceType,
	id: string,
): boolean {
	if (type === "environment") return deployment.environment === id;
	if (type === "vault") return Array.isArray(deployment.vaults) && deployment.vaults.includes(id);
	if (type !== "memory_store") return false;
	if (Array.isArray(deployment.memory_stores) && deployment.memory_stores.includes(id)) return true;
	return (
		Array.isArray(deployment.resources) &&
		deployment.resources.some(
			(resource) => isRecord(resource) && resource.type === "memory_store" && resource.memory_store === id,
		)
	);
}

async function discoverSkills(
	projectRoot: string,
	agentDirectories: string[],
	autoAssociations: ProjectAutoAssociationPlan,
): Promise<LocalSkill[]> {
	const locations: Array<{
		path: string;
		relativeDirectory: string;
		rootSkill: boolean;
		ownerAgent?: string;
	}> = [];
	for (const skillDirectory of await resourceDirectories(resolve(projectRoot, "skills"))) {
		locations.push({
			path: resolve(projectRoot, "skills", skillDirectory),
			relativeDirectory: `skills/${skillDirectory}`,
			rootSkill: true,
		});
	}
	for (const agentId of agentDirectories) {
		for (const skillDirectory of await resourceDirectories(resolve(projectRoot, "agents", agentId, "skills"))) {
			locations.push({
				path: resolve(projectRoot, "agents", agentId, "skills", skillDirectory),
				relativeDirectory: `agents/${agentId}/skills/${skillDirectory}`,
				rootSkill: false,
				ownerAgent: agentId,
			});
		}
	}
	const result: LocalSkill[] = [];
	for (const location of locations) {
		const metadataPath = resolve(location.path, "skill.json");
		let metadata: Record<string, unknown>;
		let inferred = false;
		if (await pathExists(metadataPath)) {
			metadata = await readJsonObject(metadataPath);
		} else if (location.ownerAgent && (await pathExists(resolve(location.path, "SKILL.md")))) {
			const skillId = basename(location.path);
			metadata = { id: skillId };
			inferred = true;
			planJsonWrite(autoAssociations, projectRoot, metadataPath, metadata);
			autoAssociations.warnings.push({
				severity: "warning",
				code: "project.skill.metadata.inferred",
				message: `${location.relativeDirectory}/skill.json will be created for Skill '${skillId}'.`,
			});
		} else {
			continue;
		}
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
			...(location.ownerAgent ? { ownerAgent: location.ownerAgent } : {}),
			...(inferred ? { inferred: true } : {}),
		});
	}
	return result;
}

function autoAssociateSkill(
	skill: LocalSkill,
	projectRoot: string,
	agents: Record<string, Record<string, unknown>>,
	agentSources: Map<string, Record<string, unknown>>,
	autoAssociations: ProjectAutoAssociationPlan,
): void {
	const ownerAgent = skill.ownerAgent;
	if (!ownerAgent) return;
	const agent = agents[ownerAgent];
	const agentSource = agentSources.get(ownerAgent);
	if (!agent || !agentSource) return;
	if (agent.skills !== undefined && !Array.isArray(agent.skills)) return;
	const references = Array.isArray(agent.skills) ? agent.skills : [];
	if (references.some((reference) => skillReferenceId(reference) === skill.id)) return;
	const nextReferences = [...references, skill.id];
	agent.skills = nextReferences;
	agentSource.skills = structuredClone(nextReferences);
	planJsonWrite(autoAssociations, projectRoot, resolve(projectRoot, "agents", ownerAgent, "agent.json"), agentSource);
	autoAssociations.warnings.push({
		severity: "warning",
		code: "project.skill.agent_link.inferred",
		message: `Skill '${skill.id}' will be added to agents/${ownerAgent}/agent.json.`,
	});
}

function autoAssociateFile(
	resource: LocalDirectoryResource,
	projectRoot: string,
	agents: Record<string, Record<string, unknown>>,
	agentSources: Map<string, Record<string, unknown>>,
	autoAssociations: ProjectAutoAssociationPlan,
): void {
	const ownerAgent = resource.owner_agent;
	if (!ownerAgent) return;
	const agent = agents[ownerAgent];
	const agentSource = agentSources.get(ownerAgent);
	if (!agent || !agentSource) return;
	if (agent.files !== undefined && !Array.isArray(agent.files)) return;
	const references = Array.isArray(agent.files) ? agent.files : [];
	if (references.some((reference) => isRecord(reference) && reference.file === resource.id)) return;
	const mountPath = defaultFileMountPath(resource);
	const nextReferences = [...references, { file: resource.id, mount_path: mountPath }];
	agent.files = nextReferences;
	agentSource.files = structuredClone(nextReferences);
	planJsonWrite(autoAssociations, projectRoot, resolve(projectRoot, "agents", ownerAgent, "agent.json"), agentSource);
	autoAssociations.warnings.push({
		severity: "warning",
		code: "project.file.agent_link.inferred",
		message: `File '${resource.id}' will be mounted at '${mountPath}' in agents/${ownerAgent}/agent.json.`,
	});
}

function skillReferenceId(reference: unknown): string | null {
	if (typeof reference === "string") return reference;
	return isRecord(reference) && typeof reference.skill_id === "string" ? reference.skill_id : null;
}

function defaultFileMountPath(resource: LocalDirectoryResource): string {
	const source = resource.metadata.source;
	let fileName = resource.id;
	if (typeof source === "string" && /^https?:\/\//i.test(source)) {
		try {
			fileName = basename(new URL(source).pathname) || resource.id;
		} catch {
			fileName = resource.id;
		}
	} else if (typeof source === "string") {
		fileName = basename(source) || resource.id;
	}
	return `/mnt/${fileName}`;
}

function countSkillReferences(
	agents: Record<string, Record<string, unknown>>,
	skills: Map<string, LocalSkill>,
): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const [agentId, agent] of Object.entries(agents)) {
		const refs = Array.isArray(agent.skills) ? agent.skills : [];
		for (const ref of refs) {
			const id = skillReferenceId(ref);
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
			if (IGNORED_SOURCE_NAMES.has(entry.name) || (!relativeDirectory && IGNORED_ROOT_NAMES.has(entry.name))) continue;
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
	const restoreRoot = resolve(projectRoot, PROJECT_INTERNAL_DIRECTORY, `restore-${randomUUID()}`);
	const historicalRoot = resolve(restoreRoot, "historical");
	const backupRoot = resolve(restoreRoot, "backup");
	const restoredPaths: string[] = [];
	let mutationStarted = false;
	await mkdir(restoreRoot, { recursive: true });
	try {
		await stageRestoreFiles(historicalRoot, snapshot.files, true);
		await stageRestoreFiles(backupRoot, current.source_files, false);
		const checked = await inspectDirectoryProject(projectRoot);
		if (checked.project_revision !== baseRevision) throw new UserError("Project source changed before Restore.");
		mutationStarted = true;
		const currentPaths = new Set(current.source_files.map((file) => file.path));
		for (const path of currentPaths) await rm(resolve(projectRoot, path), { force: true });
		await removeEmptyProjectDirectories(projectRoot, currentPaths);
		for (const file of snapshot.files) {
			const source = resolve(historicalRoot, file.path);
			const destination = resolve(projectRoot, file.path);
			await removeEmptyRestoreDestination(destination, file.path);
			await mkdir(dirname(destination), { recursive: true });
			await rename(source, destination);
			restoredPaths.push(file.path);
			await chmod(destination, file.mode);
		}
		await rm(resolve(projectRoot, ".openagentpack/build"), { recursive: true, force: true });
	} catch (restoreError) {
		if (mutationStarted) {
			try {
				await rollbackDirectoryRestore(projectRoot, backupRoot, current.source_files, restoredPaths);
			} catch (rollbackError) {
				throw new UserError(
					`Restore failed and rollback was incomplete. Restore error: ${errorMessage(restoreError)}. Rollback error: ${errorMessage(rollbackError)}.`,
				);
			}
		}
		throw restoreError;
	} finally {
		await rm(restoreRoot, { recursive: true, force: true });
	}
}

async function stageRestoreFiles(
	stagingRoot: string,
	files: Array<{ path: string; mode: number; content: Uint8Array }>,
	rejectIgnoredFiles: boolean,
): Promise<void> {
	for (const file of files) {
		assertSafeRelative(file.path);
		if (rejectIgnoredFiles && file.path.split("/").some((part) => IGNORED_SOURCE_NAMES.has(part))) {
			throw new UserError(`Project snapshot contains an ignored source file: ${file.path}`);
		}
		const destination = resolve(stagingRoot, file.path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, file.content, { mode: file.mode });
	}
}

async function rollbackDirectoryRestore(
	projectRoot: string,
	backupRoot: string,
	currentFiles: ProjectSourceFile[],
	restoredPaths: string[],
): Promise<void> {
	for (const path of restoredPaths) await rm(resolve(projectRoot, path), { force: true });
	await removeEmptyProjectDirectories(projectRoot, restoredPaths);
	for (const file of currentFiles) {
		const source = resolve(backupRoot, file.path);
		const destination = resolve(projectRoot, file.path);
		await clearRollbackDestination(destination);
		await mkdir(dirname(destination), { recursive: true });
		await rename(source, destination);
		await chmod(destination, file.mode);
	}
}

async function removeEmptyRestoreDestination(destination: string, relativePath: string): Promise<void> {
	let details: Awaited<ReturnType<typeof lstat>>;
	try {
		details = await lstat(destination);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return;
		throw error;
	}
	if (!details.isDirectory()) {
		throw new UserError(`Cannot restore ${relativePath}: destination is occupied by an unversioned file.`);
	}
	try {
		await rmdir(destination);
	} catch (error) {
		if (isFsError(error, "ENOTEMPTY") || isFsError(error, "EEXIST")) {
			throw new UserError(`Cannot restore ${relativePath}: destination directory contains unversioned files.`);
		}
		throw error;
	}
}

async function clearRollbackDestination(destination: string): Promise<void> {
	let details: Awaited<ReturnType<typeof lstat>>;
	try {
		details = await lstat(destination);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return;
		throw error;
	}
	if (details.isDirectory()) await rmdir(destination);
	else await rm(destination, { force: true });
}

async function removeEmptyProjectDirectories(projectRoot: string, paths: Iterable<string>): Promise<void> {
	const directories = new Set<string>();
	for (const path of paths) {
		let directory = dirname(path);
		while (directory !== ".") {
			directories.add(directory);
			directory = dirname(directory);
		}
	}
	for (const directory of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
		try {
			await rmdir(resolve(projectRoot, directory));
		} catch (error) {
			if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTEMPTY") && !isFsError(error, "EEXIST")) throw error;
		}
	}
}

function snapshotFromInspection(inspection: DirectoryProjectInspection): DirectoryProjectSnapshot {
	return {
		project_revision: inspection.project_revision,
		canonical_yaml: inspection.canonical_yaml,
		files: inspection.source_files.map((file) => ({ ...file })),
	};
}

async function applyProjectAutoAssociations(
	projectRoot: string,
	autoAssociations: ProjectAutoAssociationPlan,
): Promise<void> {
	for (const move of autoAssociations.fileMoves) {
		const source = resolve(projectRoot, move.from);
		const destination = resolve(projectRoot, move.to);
		if (await pathExists(destination)) {
			throw new UserError(`Cannot organize discovered File: ${move.to} already exists.`);
		}
		await mkdir(dirname(destination), { recursive: true });
		await rename(source, destination);
	}
	for (const [relativePath, value] of autoAssociations.jsonWrites) {
		const destination = resolve(projectRoot, relativePath);
		const mode = await stat(destination)
			.then((details) => details.mode & 0o777)
			.catch((error: unknown) => {
				if (isFsError(error, "ENOENT")) return 0o644;
				throw error;
			});
		await writeTextAtomic(destination, `${JSON.stringify(value, null, 2)}\n`, mode);
	}
}

async function applyOrganizationMove(projectRoot: string, move: ProjectOrganizationMove): Promise<void> {
	const source = resolve(projectRoot, move.from);
	const destination = resolve(projectRoot, move.to);
	if (await pathExists(destination))
		throw new UserError(`Cannot move shared ${move.resource_type} '${move.resource_id}': ${move.to} already exists.`);
	await mkdir(dirname(destination), { recursive: true });
	await rename(source, destination);
}

async function scaffoldProject(projectRoot: string): Promise<void> {
	const files = directoryProjectScaffold();
	// Reject source symlinks and collisions before writing any scaffold file.
	await scanProjectSource(projectRoot);
	for (const path of Object.keys(files)) {
		const existing = await lstat(resolve(projectRoot, path)).catch((error) => {
			if (isFsError(error, "ENOENT")) return null;
			throw error;
		});
		if (existing)
			throw new UserError(`Cannot initialize project: ${path} already exists. / 初始化被阻止：文件已存在。`);
	}
	for (const [path, content] of Object.entries(files)) await writeTextAtomic(resolve(projectRoot, path), content);
}

async function convertYamlProject(projectRoot: string, yamlPath: string): Promise<void> {
	const source = await readFile(yamlPath, "utf8");
	const inspection = await inspectProjectSource(source, yamlPath);
	const blockingDiagnostic = inspection.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (blockingDiagnostic) throw new UserError(blockingDiagnostic.message);
	const raw = parse(source) as Record<string, unknown>;
	if (!isRecord(raw)) throw new UserError("agents.yaml must contain an object.");
	const configuredProviders = isRecord(raw.providers) ? Object.keys(raw.providers) : [];
	const defaultProvider =
		isRecord(raw.defaults) && typeof raw.defaults.provider === "string" ? raw.defaults.provider : null;
	const unsupportedProviders = [
		...new Set([...configuredProviders, ...(defaultProvider ? [defaultProvider] : [])]),
	].filter((provider) => provider !== DIRECTORY_PROJECT_PROVIDER);
	if (unsupportedProviders.length > 0) {
		throw new UserError(
			`Directory projects use '${DIRECTORY_PROJECT_PROVIDER}' automatically and cannot convert providers: ${unsupportedProviders.join(", ")}.`,
		);
	}
	const agents = isRecord(raw.agents) ? raw.agents : {};
	const skills = isRecord(raw.skills) ? raw.skills : {};
	const directoryResources = Object.fromEntries(
		DIRECTORY_RESOURCE_TYPES.map((type) => {
			const section = DIRECTORY_RESOURCE_SPECS[type].section;
			return [type, isRecord(raw[section]) ? raw[section] : {}];
		}),
	) as Record<DirectoryResourceType, Record<string, unknown>>;
	const project = { ...raw };
	delete project.providers;
	if (isRecord(project.defaults)) {
		const defaults = { ...project.defaults };
		delete defaults.provider;
		if (Object.keys(defaults).length > 0) project.defaults = defaults;
		else delete project.defaults;
	}
	delete project.agents;
	delete project.skills;
	for (const type of DIRECTORY_RESOURCE_TYPES) delete project[DIRECTORY_RESOURCE_SPECS[type].section];
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
	for (const type of DIRECTORY_RESOURCE_TYPES) {
		const spec = DIRECTORY_RESOURCE_SPECS[type];
		for (const [resourceId, value] of Object.entries(directoryResources[type])) {
			if (!isRecord(value)) throw new UserError(`${spec.section}.${resourceId} must be an object.`);
			const ownerAgent = convertedResourceOwner(type, resourceId, agents, project);
			const relativeDirectory = ownerAgent
				? `agents/${ownerAgent}/${spec.directory}/${resourceId}`
				: `resources/${spec.directory}/${resourceId}`;
			const destination = resolve(projectRoot, relativeDirectory);
			await mkdir(destination, { recursive: true });
			const metadata: Record<string, unknown> = { id: resourceId, ...value };
			if (type === "file") await materializeFileSource(projectRoot, metadata, destination);
			await writeTextAtomic(resolve(destination, spec.metadataFile), `${JSON.stringify(metadata, null, 2)}\n`);
		}
	}
}

function convertedResourceOwner(
	type: DirectoryResourceType,
	id: string,
	agents: Record<string, unknown>,
	project: Record<string, unknown>,
): string | undefined {
	const owners = Object.entries(agents)
		.filter(([, agent]) => isRecord(agent) && agentReferencesDirectoryResource(agent, type, id))
		.map(([agentId]) => agentId);
	if (owners.length !== 1) return undefined;
	const deployments = isRecord(project.deployments) ? project.deployments : {};
	if (
		Object.values(deployments).some(
			(deployment) => isRecord(deployment) && deploymentReferencesDirectoryResource(deployment, type, id),
		)
	) {
		return undefined;
	}
	return owners[0];
}

async function materializeText(projectRoot: string, value: unknown, fallback: string): Promise<string> {
	if (typeof value !== "string") return fallback;
	if (value.startsWith("./") || value.startsWith("../") || isAbsolute(value)) {
		return readFile(await resolveProjectOwnedSource(projectRoot, value, "Agent instructions"), "utf8");
	}
	return value.endsWith("\n") ? value : `${value}\n`;
}

async function materializeSkillSource(projectRoot: string, source: unknown, destination: string): Promise<void> {
	if (typeof source !== "string" || /^https?:\/\//i.test(source)) {
		await writeTextAtomic(resolve(destination, "SKILL.md"), "# Skill\n");
		return;
	}
	const sourcePath = await resolveProjectOwnedSource(projectRoot, source, "Skill source");
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

async function materializeFileSource(
	projectRoot: string,
	metadata: Record<string, unknown>,
	destination: string,
): Promise<void> {
	const source = metadata.source;
	if (typeof source !== "string" || /^https?:\/\//i.test(source)) return;
	const sourcePath = await resolveProjectOwnedSource(projectRoot, source, "File source");
	const details = await stat(sourcePath);
	if (!details.isFile()) throw new UserError("File source must reference a file.");
	const originalName = basename(sourcePath);
	const fileName = originalName === "file.json" ? "content-file.json" : originalName;
	const destinationPath = resolve(destination, fileName);
	if (sourcePath !== destinationPath) await cp(sourcePath, destinationPath, { errorOnExist: true });
	metadata.source = `./${fileName}`;
}

async function resolveProjectOwnedSource(projectRoot: string, source: string, label: string): Promise<string> {
	if (isAbsolute(source)) throw new UserError(`${label} must be a relative path inside the project root.`);
	const normalizedRoot = resolve(projectRoot);
	const sourcePath = resolve(normalizedRoot, source);
	if (!isPathInside(normalizedRoot, sourcePath)) {
		throw new UserError(`${label} escapes the project root.`);
	}
	const [rootRealPath, sourceRealPath] = await Promise.all([realpath(normalizedRoot), realpath(sourcePath)]);
	if (!isPathInside(rootRealPath, sourceRealPath)) {
		throw new UserError(`${label} resolves outside the project root.`);
	}
	return sourcePath;
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
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

async function resourceDirectories(path: string): Promise<string[]> {
	return (await childDirectories(path)).filter((directory) => directory !== RESOURCE_EXAMPLES_DIRECTORY);
}

function createProjectAutoAssociationPlan(): ProjectAutoAssociationPlan {
	return { fileMoves: [], jsonWrites: new Map(), warnings: [] };
}

function planJsonWrite(
	autoAssociations: ProjectAutoAssociationPlan,
	projectRoot: string,
	path: string,
	value: Record<string, unknown>,
): void {
	if (!isPathInside(projectRoot, path))
		throw new UserError(`Cannot write inferred project metadata outside ${projectRoot}.`);
	autoAssociations.jsonWrites.set(relative(projectRoot, path).split(sep).join("/"), structuredClone(value));
}

async function directProjectFiles(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name !== "file.json")
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (isFsError(error, "ENOENT")) return [];
		throw error;
	}
}

function inferFileResourceId(fileName: string): string {
	const extension = extname(fileName);
	const stem = extension ? fileName.slice(0, -extension.length) : fileName;
	const normalized = stem
		.normalize("NFKC")
		.trim()
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || `file-${hash(fileName).slice(0, 8)}`;
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

function projectPublishPlanFingerprint(planned: ResourcePlanResult): string {
	return hash(
		stableStringify({
			actions: planned.plan.actions,
			diagnostics: planned.plan.diagnostics,
		}),
	);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

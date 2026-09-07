import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	getProjectBuildStatus,
	inspectDirectoryProject,
	PROJECT_BUILD_FILE,
	PROJECT_METADATA_FILE,
	PROJECT_STATE_FILE,
	resolveDirectoryProjectRuntime,
} from "@openagentpack/project-workspace";
import {
	type AgentWithReadiness,
	type BackendRuntimeInput,
	type Diagnostic,
	LocalFileStateBackend,
	listAgentsWithReadiness,
	type ResolvedProjectConfig,
	readProjectRuntime,
} from "@openagentpack/sdk";
import { type FSWatcher, watch } from "chokidar";
import { type ProjectMutationSnapshot, projectMutationCoordinator } from "@/services/project-mutations";

export type ProjectStatus = "loading" | "valid" | "invalid" | "missing";
export type ProjectChangeType = "project.reloading" | "project.valid" | "project.invalid" | "project.missing";

export interface ProjectChangeEvent {
	type: ProjectChangeType;
	revision?: string;
	status: ProjectStatus;
}

interface ProjectSnapshot {
	status: ProjectStatus;
	configPath: string;
	projectName: string;
	revision?: string;
	diagnostics: Diagnostic[];
	config?: ResolvedProjectConfig;
	input?: BackendRuntimeInput;
	sourcePaths: string[];
}

export interface ProjectAgentSummary extends AgentWithReadiness {
	details: {
		environment?: string;
		vault?: string;
		memory_stores: string[];
		resources: Array<{ type: string; mount_path?: string }>;
	};
}

export interface ProjectDeploymentSummary {
	id: string;
	agent: string;
	provider?: string;
	description?: string;
	schedule?: { expression: string; timezone: string };
	initial_event_types: string[];
	resource_types: string[];
}

export interface ProjectSummary {
	status: ProjectStatus;
	config_file: string;
	project_name: string;
	revision?: string;
	diagnostics: Diagnostic[];
	agents: ProjectAgentSummary[];
	deployments: ProjectDeploymentSummary[];
	active_mutation: ProjectMutationSnapshot | null;
	build: { exists: boolean; stale: boolean; reasons: string[]; yaml_hash?: string };
}

type ProjectListener = (event: ProjectChangeEvent) => void;

export class ProjectUnavailableError extends Error {
	readonly status = 422;
	constructor(message: string) {
		super(message);
		this.name = "ProjectUnavailableError";
	}
}

export class ProjectRuntimeManager {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly projectId: string;
	private snapshot: ProjectSnapshot;
	private startPromise?: Promise<void>;
	private reloadTimer?: ReturnType<typeof setTimeout>;
	private watcher?: FSWatcher;
	private readonly listeners = new Set<ProjectListener>();
	private readinessCache?: { revision: string; agents: AgentWithReadiness[] };

	constructor(projectDirectory = process.env.AGENTS_PROJECT_ROOT?.trim() || ".") {
		this.projectRoot = resolve(projectDirectory);
		this.configPath = resolve(this.projectRoot, PROJECT_BUILD_FILE);
		this.projectId = createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 16);
		this.snapshot = {
			status: "loading",
			configPath: this.configPath,
			projectName: basename(this.projectRoot),
			diagnostics: [],
			sourcePaths: [resolve(this.projectRoot, PROJECT_METADATA_FILE)],
		};
	}

	async ensureStarted(): Promise<void> {
		this.startPromise ??= this.reload();
		await this.startPromise;
	}

	getSnapshot(): Readonly<ProjectSnapshot> {
		return this.snapshot;
	}

	async computeCurrentSourceRevision(): Promise<string> {
		await this.ensureStarted();
		return (await inspectDirectoryProject(this.projectRoot)).project_revision;
	}

	requireRuntimeInput(): BackendRuntimeInput {
		if (this.snapshot.status !== "valid" || !this.snapshot.input) {
			throw new ProjectUnavailableError(
				`Directory project is ${this.snapshot.status}. Fix ${this.projectRoot} before starting a new operation.`,
			);
		}
		return this.snapshot.input;
	}

	subscribe(listener: ProjectListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getSummary(options: { refreshReadiness?: boolean } = {}): Promise<ProjectSummary> {
		await this.ensureStarted();
		const snapshot = this.snapshot;
		let agents: AgentWithReadiness[] = [];
		if (snapshot.config && snapshot.input && snapshot.revision) {
			if (options.refreshReadiness || this.readinessCache?.revision !== snapshot.revision) {
				agents = await readProjectRuntime(snapshot.input, (ctx) =>
					listAgentsWithReadiness(ctx, { refresh: options.refreshReadiness ?? false }),
				);
				this.readinessCache = { revision: snapshot.revision, agents };
			} else {
				agents = this.readinessCache.agents;
			}
		}

		return {
			status: snapshot.status,
			config_file: snapshot.configPath,
			project_name: snapshot.projectName,
			revision: snapshot.revision,
			diagnostics: snapshot.diagnostics,
			agents: agents.map((entry) => ({
				...entry,
				details: projectAgentDetails(snapshot.config, entry.agent.id),
			})),
			deployments: projectDeployments(snapshot.config),
			active_mutation: projectMutationCoordinator.getSnapshot(),
			build: await getProjectBuildStatus(this.projectRoot).then((status) => ({
				exists: status.exists,
				stale: status.stale,
				reasons: status.reasons,
				yaml_hash: status.manifest?.yaml_hash,
			})),
		};
	}

	async refreshAfterMutation(): Promise<void> {
		this.readinessCache = undefined;
		await this.reload(false);
	}

	async refreshAfterSourceMutation(): Promise<string | undefined> {
		this.readinessCache = undefined;
		await this.reload(false);
		return this.snapshot.revision;
	}

	scheduleReload(): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			void this.reload();
		}, 200);
	}

	close(): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		void this.closeWatcher();
		this.listeners.clear();
	}

	private async reload(emitReloading = true): Promise<void> {
		if (emitReloading) this.emit({ type: "project.reloading", status: "loading" });
		const previous = this.snapshot;
		let next: ProjectSnapshot;
		try {
			if (!existsSync(resolve(this.projectRoot, PROJECT_METADATA_FILE))) {
				next = {
					status: "missing",
					configPath: this.configPath,
					projectName: basename(this.projectRoot),
					diagnostics: [
						{
							severity: "error",
							code: "project.config.missing",
							message: `Directory project not found: ${resolve(this.projectRoot, PROJECT_METADATA_FILE)}`,
						},
					],
					sourcePaths: [resolve(this.projectRoot, PROJECT_METADATA_FILE)],
				};
			} else {
				const inspection = await inspectDirectoryProject(this.projectRoot);
				const diagnostics = [...inspection.diagnostics, ...inspection.warnings];
				const revision = inspection.project_revision;
				const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
				const loaded = inspection.loaded;
				const runtimeLoaded = loaded && !hasErrors ? await resolveDirectoryProjectRuntime(this.projectRoot) : loaded;
				const input: BackendRuntimeInput | undefined = runtimeLoaded
					? {
							projectName: basename(this.projectRoot),
							config: runtimeLoaded.config,
							configPath: this.configPath,
							providers: runtimeLoaded.config.providers,
							stateBackend: new LocalFileStateBackend({ statePath: resolve(this.projectRoot, PROJECT_STATE_FILE) }),
							stateScope: { projectId: basename(this.projectRoot) },
						}
					: undefined;
				next = {
					status: hasErrors ? "invalid" : "valid",
					configPath: this.configPath,
					projectName: basename(this.projectRoot),
					revision,
					diagnostics,
					config: runtimeLoaded?.config,
					input,
					sourcePaths: inspection.source_files.map((file) => resolve(this.projectRoot, file.path)),
				};
			}
		} catch (error) {
			const failedSourcePaths =
				error && typeof error === "object" && "sourcePaths" in error && Array.isArray(error.sourcePaths)
					? error.sourcePaths.filter((sourcePath): sourcePath is string => typeof sourcePath === "string")
					: [resolve(this.projectRoot, PROJECT_METADATA_FILE)];
			const revision = await inspectDirectoryProject(this.projectRoot)
				.then((value) => value.project_revision)
				.catch(() => undefined);
			next = {
				status: "invalid",
				configPath: this.configPath,
				projectName: basename(this.projectRoot),
				revision,
				diagnostics: [
					{
						severity: "error",
						code: "project.config.invalid",
						message: error instanceof Error ? error.message : String(error),
					},
				],
				sourcePaths: failedSourcePaths,
			};
		}

		this.snapshot = next;
		this.readinessCache = undefined;
		await this.resetWatcher();
		if (snapshotIdentity(previous) !== snapshotIdentity(next)) {
			this.emit({
				type:
					next.status === "valid" ? "project.valid" : next.status === "missing" ? "project.missing" : "project.invalid",
				status: next.status,
				revision: next.revision,
			});
		}
	}

	private emit(event: ProjectChangeEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private async resetWatcher(): Promise<void> {
		await this.closeWatcher();
		const watcher = watch(this.projectRoot, {
			ignoreInitial: true,
			ignored: (path) =>
				path === resolve(this.projectRoot, ".openagentpack") ||
				path.startsWith(`${resolve(this.projectRoot, ".openagentpack")}/`),
			usePolling: typeof Bun !== "undefined",
			interval: 100,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
		});
		watcher.on("all", () => this.scheduleReload());
		watcher.on("error", (error) => {
			console.warn(`[project] File watcher error: ${error instanceof Error ? error.message : error}`);
		});
		await new Promise<void>((resolveReady) => watcher.once("ready", resolveReady));
		this.watcher = watcher;
	}

	private async closeWatcher(): Promise<void> {
		const watcher = this.watcher;
		this.watcher = undefined;
		if (watcher) await watcher.close();
	}
}

function snapshotIdentity(snapshot: ProjectSnapshot): string {
	return `${snapshot.status}:${snapshot.revision ?? ""}:${snapshot.diagnostics
		.map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`)
		.join("|")}`;
}

function projectAgentDetails(
	config: ResolvedProjectConfig | undefined,
	agentId: string,
): ProjectAgentSummary["details"] {
	const agent = config?.agents?.[agentId];
	return {
		environment: agent?.environment,
		vault: agent?.vault,
		memory_stores: agent?.memory_stores ?? [],
		resources: (agent?.resources ?? []).map((resource) => ({
			type: resource.type,
			mount_path: resource.mount_path,
		})),
	};
}

function projectDeployments(config: ResolvedProjectConfig | undefined): ProjectDeploymentSummary[] {
	return Object.entries(config?.deployments ?? {}).map(([id, deployment]) => ({
		id,
		agent: deployment.agent,
		provider: deployment.provider,
		description: deployment.description,
		schedule: deployment.schedule,
		initial_event_types: deployment.initial_events.map((event) => event.type),
		resource_types: (deployment.resources ?? []).map((resource) => resource.type),
	}));
}

if (process.env.AGENTS_CONFIG_PATH?.trim() && process.env.AGENTS_PROJECT_ROOT?.trim()) {
	throw new Error("AGENTS_CONFIG_PATH and AGENTS_PROJECT_ROOT cannot be used by the same Workbench process.");
}

export const projectRuntimeManager = new ProjectRuntimeManager();

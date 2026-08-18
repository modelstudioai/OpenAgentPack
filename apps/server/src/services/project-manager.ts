import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	type AgentWithReadiness,
	type BackendRuntimeInput,
	type Diagnostic,
	LocalFileStateBackend,
	listAgentsWithReadiness,
	type ResolvedProjectConfig,
	readProjectRuntime,
	resolveProjectConfig,
	validateProjectConfig,
} from "@openagentpack/sdk";
import { type FSWatcher, watch } from "chokidar";

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
	readonly projectId: string;
	private snapshot: ProjectSnapshot;
	private startPromise?: Promise<void>;
	private reloadTimer?: ReturnType<typeof setTimeout>;
	private watcher?: FSWatcher;
	private readonly listeners = new Set<ProjectListener>();
	private readinessCache?: { revision: string; agents: AgentWithReadiness[] };

	constructor(configPath = process.env.AGENTS_CONFIG_PATH?.trim() || "agents.yaml") {
		this.configPath = resolve(configPath);
		this.projectId = createHash("sha256").update(this.configPath).digest("hex").slice(0, 16);
		this.snapshot = {
			status: "loading",
			configPath: this.configPath,
			projectName: basename(dirname(this.configPath)),
			diagnostics: [],
			sourcePaths: [this.configPath],
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
		return computeProjectRevision([...this.snapshot.sourcePaths]);
	}

	requireRuntimeInput(): BackendRuntimeInput {
		if (this.snapshot.status !== "valid" || !this.snapshot.input) {
			throw new ProjectUnavailableError(
				`Project configuration is ${this.snapshot.status}. Fix ${this.configPath} before starting a new operation.`,
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
			if (!existsSync(this.configPath)) {
				next = {
					status: "missing",
					configPath: this.configPath,
					projectName: basename(dirname(this.configPath)),
					diagnostics: [
						{
							severity: "error",
							code: "project.config.missing",
							message: `Configuration file not found: ${this.configPath}`,
						},
					],
					sourcePaths: [this.configPath],
				};
			} else {
				const loaded = await resolveProjectConfig(this.configPath);
				const diagnostics = validateProjectConfig(loaded.config);
				const revision = await computeProjectRevision(loaded.sourcePaths);
				const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
				const input: BackendRuntimeInput = {
					projectName: loaded.projectName,
					config: loaded.config,
					configPath: loaded.configPath,
					providers: loaded.config.providers,
					stateBackend: new LocalFileStateBackend({ configPath: loaded.configPath }),
					stateScope: { projectId: loaded.projectName },
				};
				next = {
					status: hasErrors ? "invalid" : "valid",
					configPath: loaded.configPath,
					projectName: loaded.projectName,
					revision,
					diagnostics,
					config: loaded.config,
					input,
					sourcePaths: loaded.sourcePaths,
				};
			}
		} catch (error) {
			const failedSourcePaths =
				error && typeof error === "object" && "sourcePaths" in error && Array.isArray(error.sourcePaths)
					? error.sourcePaths.filter((sourcePath): sourcePath is string => typeof sourcePath === "string")
					: [this.configPath];
			next = {
				status: "invalid",
				configPath: this.configPath,
				projectName: basename(dirname(this.configPath)),
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
		await this.resetWatcher(next.sourcePaths);
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

	private async resetWatcher(sourcePaths: string[]): Promise<void> {
		await this.closeWatcher();
		const watcher = watch(collectWatchPaths(sourcePaths), {
			ignoreInitial: true,
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

function collectWatchPaths(sourcePaths: string[]): string[] {
	const watchPaths = new Set<string>();
	for (const sourcePath of sourcePaths) {
		if (existsSync(sourcePath)) {
			watchPaths.add(sourcePath);
			continue;
		}
		let existingParent = dirname(sourcePath);
		while (!existsSync(existingParent)) {
			const parent = dirname(existingParent);
			if (parent === existingParent) break;
			existingParent = parent;
		}
		watchPaths.add(existingParent);
	}
	return [...watchPaths];
}

function snapshotIdentity(snapshot: ProjectSnapshot): string {
	return `${snapshot.status}:${snapshot.revision ?? ""}:${snapshot.diagnostics
		.map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`)
		.join("|")}`;
}

async function computeProjectRevision(sourcePaths: string[]): Promise<string> {
	const hash = createHash("sha256");
	const visited = new Set<string>();
	for (const sourcePath of [...sourcePaths].sort()) {
		await appendPathToHash(hash, sourcePath, visited);
	}
	return hash.digest("hex");
}

async function appendPathToHash(
	hash: ReturnType<typeof createHash>,
	sourcePath: string,
	visited: Set<string>,
): Promise<void> {
	let sourceRealPath: string;
	try {
		sourceRealPath = await realpath(sourcePath);
	} catch {
		hash.update(`missing:${sourcePath}\n`);
		return;
	}
	if (visited.has(sourceRealPath)) return;
	visited.add(sourceRealPath);
	const sourceStat = await stat(sourceRealPath);
	if (sourceStat.isDirectory()) {
		hash.update(`directory:${sourcePath}\n`);
		for (const entry of (await readdir(sourceRealPath)).sort()) {
			await appendPathToHash(hash, resolve(sourceRealPath, entry), visited);
		}
		return;
	}
	if (sourceStat.isFile()) {
		hash.update(`file:${sourcePath}\n`);
		hash.update(await readFile(sourceRealPath));
		hash.update("\n");
	}
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

export const projectRuntimeManager = new ProjectRuntimeManager();

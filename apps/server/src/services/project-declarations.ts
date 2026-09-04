import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
	acquireDirectoryProjectMutation,
	type DirectoryResourceType,
	inspectDirectoryProject,
	locateDirectoryProjectResource,
} from "@openagentpack/project-workspace";
import {
	type Diagnostic,
	type ResolvedProjectConfig,
	resolveProjectConfigFromObject,
	validateProjectConfig,
} from "@openagentpack/sdk";
import { parse, stringify } from "yaml";
import { type ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";

export const DECLARATION_TYPES = ["agent", "environment", "skill", "vault", "memory_store", "file"] as const;
export type DeclarationType = (typeof DECLARATION_TYPES)[number];

export interface DeclarationPatchOperation {
	op: "set" | "remove";
	path: string[];
	value?: unknown;
}

export interface DeclarationReference {
	type: string;
	id: string;
	path: string;
}

export interface DeclarationResource {
	type: DeclarationType;
	id: string;
	owner_agent?: string;
	declaration: Record<string, unknown>;
	read_only_paths: string[][];
	references: DeclarationReference[];
}

export interface DeclarationPreview {
	type: DeclarationType;
	id: string;
	action: "update" | "delete";
	base_revision: string;
	before_yaml: string;
	after_yaml: string;
	diagnostics: Diagnostic[];
	references: DeclarationReference[];
	can_commit: boolean;
}

interface PreparedDeclarationChange extends DeclarationPreview {
	target: SourceTarget;
	content?: string;
	contentFileContent?: string;
	deletePath?: string;
}

interface SourceTarget {
	kind: "agent" | "skill" | "resource" | "project";
	path: string;
	contentPath?: string;
	ownerAgent?: string;
}

const SECTION_BY_TYPE: Record<DeclarationType, string> = {
	agent: "agents",
	environment: "environments",
	skill: "skills",
	vault: "vaults",
	memory_store: "memory_stores",
	file: "files",
};

const EDITABLE_FIELDS: Record<DeclarationType, ReadonlySet<string>> = {
	agent: new Set([
		"name",
		"description",
		"model",
		"instructions",
		"environment",
		"tunnel",
		"provider",
		"tools",
		"mcp_servers",
		"skills",
		"vault",
		"memory_stores",
		"files",
		"resources",
		"multiagent",
		"metadata",
		"environment_variables",
		"delivery",
	]),
	environment: new Set(["name", "description", "provider", "config", "metadata"]),
	skill: new Set(["name", "content", "description", "version", "origin", "provider"]),
	vault: new Set(["display_name", "provider", "credentials", "metadata"]),
	memory_store: new Set(["description", "provider", "metadata", "entries"]),
	file: new Set(["name", "purpose", "provider"]),
};

const SENSITIVE_KEY = /(access[_-]?key|api[_-]?key|authorization|credential|headers?|password|secret|signature|token)/i;
const REDACTED = "[redacted]";
let sourceMutationQueue: Promise<void> = Promise.resolve();

export class DeclarationProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "DeclarationProtocolError";
	}
}

export async function listProjectDeclarations(
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<{ revision: string; resources: DeclarationResource[] }> {
	const source = await readValidProject(manager);
	const resources: DeclarationResource[] = [];
	for (const type of DECLARATION_TYPES) {
		const section = recordValue(source.config[SECTION_BY_TYPE[type]]);
		for (const [id, rawDeclaration] of Object.entries(section)) {
			if (!isRecord(rawDeclaration)) continue;
			const target = await locateSourceTarget(manager.projectRoot, type, id, rawDeclaration);
			const declaration = await declarationForEditor(type, id, rawDeclaration, target);
			resources.push({
				type,
				id,
				...(target.ownerAgent ? { owner_agent: target.ownerAgent } : {}),
				declaration: redactSensitive(declaration) as Record<string, unknown>,
				read_only_paths: readOnlyPaths(type, declaration),
				references: findDeclarationReferences(source.config, type, id),
			});
		}
	}
	return { revision: source.revision, resources };
}

export async function previewDeclarationChange(
	input: {
		type: DeclarationType;
		id: string;
		baseRevision: string;
		action: "update" | "delete";
		operations?: DeclarationPatchOperation[];
	},
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<DeclarationPreview> {
	return publicPreview(await prepareDeclarationChange(input, manager));
}

export async function commitDeclarationChange(
	input: {
		type: DeclarationType;
		id: string;
		baseRevision: string;
		action: "update" | "delete";
		operations?: DeclarationPatchOperation[];
	},
	manager: ProjectRuntimeManager = projectRuntimeManager,
): Promise<DeclarationPreview & { new_revision: string }> {
	return serializeSourceMutation(async () => {
		const lease = projectMutationCoordinator.acquire("declaration_write");
		let filesystemLease: Awaited<ReturnType<typeof acquireDirectoryProjectMutation>> | undefined;
		try {
			filesystemLease = await acquireDirectoryProjectMutation(manager.projectRoot, "declaration_write");
			const prepared = await prepareDeclarationChange(input, manager);
			if (!prepared.can_commit) {
				const blockedByReferences = prepared.action === "delete" && prepared.references.length > 0;
				throw new DeclarationProtocolError(
					blockedByReferences
						? `Cannot delete ${prepared.type}.${prepared.id}; it is referenced by ${prepared.references.map((reference) => reference.path).join(", ")}.`
						: (prepared.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
								"The declaration change is invalid."),
					blockedByReferences ? 409 : 422,
				);
			}
			if ((await manager.computeCurrentSourceRevision()) !== prepared.base_revision) {
				throw new DeclarationProtocolError("Project files changed. Reload before saving this edit.", 409);
			}
			if (prepared.action === "delete") {
				await commitDelete(manager.projectRoot, prepared);
			} else if (prepared.content !== undefined) {
				await writeTextAtomic(prepared.target.path, prepared.content);
				if (prepared.target.contentPath && prepared.contentFileContent !== undefined) {
					await writeTextAtomic(prepared.target.contentPath, prepared.contentFileContent);
				}
			}
			const newRevision = await manager.refreshAfterSourceMutation();
			if (!newRevision) throw new DeclarationProtocolError("The saved project has no revision.", 500);
			return { ...publicPreview(prepared), new_revision: newRevision };
		} finally {
			await filesystemLease?.release();
			lease.release();
		}
	});
}

async function prepareDeclarationChange(
	input: {
		type: DeclarationType;
		id: string;
		baseRevision: string;
		action: "update" | "delete";
		operations?: DeclarationPatchOperation[];
	},
	manager: ProjectRuntimeManager,
): Promise<PreparedDeclarationChange> {
	const source = await readValidProject(manager);
	if (source.revision !== input.baseRevision)
		throw new DeclarationProtocolError("Project files changed. Reload before editing.", 409);
	const sectionName = SECTION_BY_TYPE[input.type];
	const sectionBefore = recordValue(source.config[sectionName]);
	const rawBefore = sectionBefore[input.id];
	if (!isRecord(rawBefore))
		throw new DeclarationProtocolError(`${input.type}.${input.id} is not declared in this project.`, 404);
	const target = await locateSourceTarget(manager.projectRoot, input.type, input.id, rawBefore);
	const editorBefore = await declarationForEditor(input.type, input.id, rawBefore, target);
	const configAfter = structuredClone(source.config);
	const sectionAfter = recordValue(configAfter[sectionName]);
	const references = findDeclarationReferences(source.config, input.type, input.id);
	let editorAfter: Record<string, unknown> | null = null;
	let content: string | undefined;
	let contentFileContent: string | undefined;
	if (input.action === "delete") {
		delete sectionAfter[input.id];
		if (Object.keys(sectionAfter).length === 0) delete configAfter[sectionName];
		else configAfter[sectionName] = sectionAfter;
	} else {
		const operations = input.operations ?? [];
		if (operations.length === 0) throw new DeclarationProtocolError("At least one patch operation is required.", 400);
		editorAfter = structuredClone(editorBefore);
		for (const operation of operations) applyPlainPatch(editorAfter, input.type, operation);
		const rawAfter = rawDeclarationForConfig(input.type, editorAfter, rawBefore);
		sectionAfter[input.id] = rawAfter;
		configAfter[sectionName] = sectionAfter;
		const rendered = await sourceContentForTarget(input.type, input.id, target, editorAfter);
		content = rendered.metadata;
		contentFileContent = rendered.contentFile;
	}
	const diagnostics = redactSensitive(await validateConfig(configAfter, manager.projectRoot)) as Diagnostic[];
	const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
	return {
		type: input.type,
		id: input.id,
		action: input.action,
		base_revision: source.revision,
		before_yaml: declarationSnippet(input.id, editorBefore),
		after_yaml: editorAfter ? declarationSnippet(input.id, editorAfter) : "# declaration removed\n",
		diagnostics,
		references,
		can_commit: !hasErrors && (input.action !== "delete" || references.length === 0),
		target,
		content,
		contentFileContent,
		deletePath: input.action === "delete" ? deletePathForTarget(input.type, target) : undefined,
	};
}

async function readValidProject(manager: ProjectRuntimeManager): Promise<{
	revision: string;
	config: Record<string, unknown>;
}> {
	await manager.ensureStarted();
	const snapshot = manager.getSnapshot();
	if (snapshot.status !== "valid" || !snapshot.revision) {
		throw new DeclarationProtocolError(
			`Directory project is ${snapshot.status}. Fix ${manager.projectRoot} before editing.`,
			422,
		);
	}
	const inspection = await inspectDirectoryProject(manager.projectRoot);
	if (!inspection.canonical_yaml) throw new DeclarationProtocolError("Directory project cannot be compiled.", 422);
	const config = parse(inspection.canonical_yaml);
	if (!isRecord(config)) throw new DeclarationProtocolError("Compiled project must be an object.", 422);
	return { revision: inspection.project_revision, config };
}

async function locateSourceTarget(
	projectRoot: string,
	type: DeclarationType,
	id: string,
	declaration: Record<string, unknown>,
): Promise<SourceTarget> {
	if (type === "agent") {
		return {
			kind: "agent",
			path: resolve(projectRoot, "agents", id, "agent.json"),
			contentPath: resolve(projectRoot, "agents", id, "instructions.md"),
		};
	}
	if (type === "skill") {
		if (typeof declaration.source !== "string")
			throw new DeclarationProtocolError(`skill.${id} has no local source.`, 422);
		const skillDirectory = resolve(projectRoot, ".openagentpack", "build", declaration.source);
		if (!isWithin(projectRoot, skillDirectory))
			throw new DeclarationProtocolError(`skill.${id} source escapes the project root.`, 422);
		return {
			kind: "skill",
			path: resolve(skillDirectory, "skill.json"),
			contentPath: resolve(skillDirectory, "SKILL.md"),
			...ownerAgentFromPath(projectRoot, skillDirectory),
		};
	}
	const source = await locateDirectoryProjectResource(projectRoot, type as DirectoryResourceType, id);
	if (!source) throw new DeclarationProtocolError(`${type}.${id} has no directory source.`, 422);
	return { kind: "resource", path: source.path, ownerAgent: source.owner_agent };
}

function ownerAgentFromPath(projectRoot: string, sourceDirectory: string): { ownerAgent?: string } {
	const parts = relative(projectRoot, sourceDirectory).split(/[\\/]/);
	return parts[0] === "agents" && parts[1] ? { ownerAgent: parts[1] } : {};
}

async function declarationForEditor(
	type: DeclarationType,
	id: string,
	declaration: Record<string, unknown>,
	target: SourceTarget,
): Promise<Record<string, unknown>> {
	let source = declaration;
	if (target.kind === "project") {
		const project = JSON.parse(await readFile(target.path, "utf8")) as Record<string, unknown>;
		const authored = recordValue(project[SECTION_BY_TYPE[type]])[id];
		if (isRecord(authored)) source = authored;
	} else if (target.kind === "resource") {
		const authored = JSON.parse(await readFile(target.path, "utf8")) as Record<string, unknown>;
		source = { ...authored };
		delete source.id;
	}
	const result = structuredClone(source);
	if (type === "agent" && target.contentPath) result.instructions = await readFile(target.contentPath, "utf8");
	if (type === "skill" && target.contentPath) result.content = await readFile(target.contentPath, "utf8");
	return result;
}

function rawDeclarationForConfig(
	type: DeclarationType,
	editor: Record<string, unknown>,
	before: Record<string, unknown>,
): Record<string, unknown> {
	const raw = restoreSensitiveSentinels(structuredClone(editor), before) as Record<string, unknown>;
	if (type === "agent") raw.instructions = before.instructions;
	if (type === "skill") {
		delete raw.content;
		raw.source = before.source;
	}
	if (type === "file") raw.source = before.source;
	return raw;
}

async function sourceContentForTarget(
	type: DeclarationType,
	id: string,
	target: SourceTarget,
	editor: Record<string, unknown>,
): Promise<{ metadata: string; contentFile?: string }> {
	if (type === "agent") {
		if (typeof editor.instructions !== "string")
			throw new DeclarationProtocolError("Agent instructions must be text.", 400);
		const agent = { ...editor };
		delete agent.instructions;
		return { metadata: `${JSON.stringify(agent, null, 2)}\n`, contentFile: editor.instructions };
	}
	if (type === "skill") {
		if (typeof editor.content !== "string") throw new DeclarationProtocolError("Skill content must be text.", 400);
		const existing = JSON.parse(await readFile(target.path, "utf8")) as Record<string, unknown>;
		const metadata: Record<string, unknown> = { ...editor, id: existing.id };
		delete metadata.content;
		delete metadata.source;
		return { metadata: `${JSON.stringify(metadata, null, 2)}\n`, contentFile: editor.content };
	}
	if (target.kind === "resource") {
		const existing = JSON.parse(await readFile(target.path, "utf8")) as Record<string, unknown>;
		const metadata: Record<string, unknown> = { ...editor, id: existing.id };
		if (type === "file") metadata.source = existing.source;
		return { metadata: `${JSON.stringify(metadata, null, 2)}\n` };
	}
	const project = JSON.parse(await readFile(target.path, "utf8")) as Record<string, unknown>;
	const section = SECTION_BY_TYPE[type];
	const entries = recordValue(project[section]);
	entries[id] = editor;
	project[section] = entries;
	return { metadata: `${JSON.stringify(project, null, 2)}\n` };
}

async function commitDelete(projectRoot: string, prepared: PreparedDeclarationChange): Promise<void> {
	if (prepared.target.kind === "project") {
		const project = JSON.parse(await readFile(prepared.target.path, "utf8")) as Record<string, unknown>;
		const sectionName = SECTION_BY_TYPE[prepared.type];
		const section = recordValue(project[sectionName]);
		delete section[prepared.id];
		if (Object.keys(section).length === 0) delete project[sectionName];
		else project[sectionName] = section;
		await writeTextAtomic(prepared.target.path, `${JSON.stringify(project, null, 2)}\n`);
		return;
	}
	if (!prepared.deletePath) throw new DeclarationProtocolError("Declaration has no removable source path.", 422);
	const trash = resolve(projectRoot, ".openagentpack", "trash", `${prepared.type}-${prepared.id}-${randomUUID()}`);
	await mkdir(dirname(trash), { recursive: true });
	await rename(prepared.deletePath, trash);
}

function deletePathForTarget(type: DeclarationType, target: SourceTarget): string | undefined {
	if (type === "agent") return dirname(target.path);
	if (type === "skill") return dirname(target.path);
	if (target.kind === "resource") return type === "file" ? target.path : dirname(target.path);
	return undefined;
}

function applyPlainPatch(
	target: Record<string, unknown>,
	type: DeclarationType,
	operation: DeclarationPatchOperation,
): void {
	if (operation.path.length === 0 || operation.path.some((entry) => !entry.trim())) {
		throw new DeclarationProtocolError("Patch paths must contain non-empty fields.", 400);
	}
	const field = operation.path[0]!;
	if (!EDITABLE_FIELDS[type].has(field))
		throw new DeclarationProtocolError(`Field '${field}' is not editable for ${type}.`, 400);
	if (operation.op === "set")
		setAtPath(target, operation.path, restoreSensitiveSentinels(operation.value, valueAtPath(target, operation.path)));
	else deleteAtPath(target, operation.path);
}

function setAtPath(target: Record<string, unknown>, path: string[], value: unknown): void {
	let current: Record<string, unknown> | unknown[] = target;
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index]!;
		const next: unknown = Array.isArray(current) ? current[Number(key)] : current[key];
		if (!isRecord(next) && !Array.isArray(next))
			throw new DeclarationProtocolError(`Patch path '${path.join(".")}' does not exist.`, 400);
		current = next;
	}
	const key = path.at(-1)!;
	if (Array.isArray(current)) current[Number(key)] = value;
	else current[key] = value;
}

function deleteAtPath(target: Record<string, unknown>, path: string[]): void {
	let current: Record<string, unknown> | unknown[] = target;
	for (const key of path.slice(0, -1)) {
		const next: unknown = Array.isArray(current) ? current[Number(key)] : current[key];
		if (!isRecord(next) && !Array.isArray(next)) return;
		current = next;
	}
	const key = path.at(-1)!;
	if (Array.isArray(current)) current.splice(Number(key), 1);
	else delete current[key];
}

async function validateConfig(config: Record<string, unknown>, projectRoot: string): Promise<Diagnostic[]> {
	try {
		const loaded = await resolveProjectConfigFromObject(config, {
			projectName: basename(projectRoot),
			basePath: resolve(projectRoot, ".openagentpack", "build"),
		});
		return validateProjectConfig(loaded.config);
	} catch (error) {
		return [
			{
				severity: "error",
				code: "project.config.invalid",
				message: error instanceof Error ? error.message : String(error),
			},
		];
	}
}

function findDeclarationReferences(
	config: Record<string, unknown>,
	type: DeclarationType,
	id: string,
): DeclarationReference[] {
	const resolved = config as unknown as ResolvedProjectConfig;
	const references: DeclarationReference[] = [];
	const add = (referenceType: string, referenceId: string, path: string): void => {
		references.push({ type: referenceType, id: referenceId, path });
	};
	for (const [agentId, agent] of Object.entries(resolved.agents ?? {})) {
		if (type === "environment" && agent.environment === id) add("agent", agentId, `agents.${agentId}.environment`);
		if (
			type === "skill" &&
			agent.skills?.some((skill) => skill === id || (typeof skill === "object" && skill.skill_id === id))
		) {
			add("agent", agentId, `agents.${agentId}.skills`);
		}
		if (type === "vault" && agent.vault === id) add("agent", agentId, `agents.${agentId}.vault`);
		if (type === "memory_store" && agent.memory_stores?.includes(id))
			add("agent", agentId, `agents.${agentId}.memory_stores`);
		if (type === "file" && agent.files?.some((file) => file.file === id))
			add("agent", agentId, `agents.${agentId}.files`);
		if (type === "agent" && agentId !== id && agent.multiagent?.agents.includes(id))
			add("agent", agentId, `agents.${agentId}.multiagent.agents`);
	}
	if (type === "agent") {
		for (const [channelId, channel] of Object.entries(resolved.channels ?? {}))
			if (channel.agent === id) add("channel", channelId, `channels.${channelId}.agent`);
	}
	for (const [deploymentId, deployment] of Object.entries(resolved.deployments ?? {})) {
		if (type === "agent" && deployment.agent === id)
			add("deployment", deploymentId, `deployments.${deploymentId}.agent`);
		if (type === "environment" && deployment.environment === id)
			add("deployment", deploymentId, `deployments.${deploymentId}.environment`);
		if (type === "vault" && deployment.vaults?.includes(id))
			add("deployment", deploymentId, `deployments.${deploymentId}.vaults`);
		if (type === "memory_store" && deployment.memory_stores?.includes(id))
			add("deployment", deploymentId, `deployments.${deploymentId}.memory_stores`);
		if (
			type === "memory_store" &&
			deployment.resources?.some(
				(resource) => resource.type === "memory_store" && "memory_store" in resource && resource.memory_store === id,
			)
		) {
			add("deployment", deploymentId, `deployments.${deploymentId}.resources`);
		}
	}
	return references;
}

function readOnlyPaths(type: DeclarationType, declaration: Record<string, unknown>): string[][] {
	const paths: string[][] = [];
	if (type === "environment" && declaration.environment_id !== undefined) paths.push(["environment_id"]);
	if (type === "skill") paths.push(["source"]);
	if (type === "file") paths.push(["source"]);
	return paths;
}

function declarationSnippet(id: string, declaration: unknown): string {
	return stringify({ [id]: redactSensitive(declaration) }, { lineWidth: 0 });
}

function publicPreview(prepared: PreparedDeclarationChange): DeclarationPreview {
	const {
		target: _target,
		content: _content,
		contentFileContent: _contentFileContent,
		deletePath: _deletePath,
		...preview
	} = prepared;
	return preview;
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
	const details = await stat(path);
	const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: details.mode });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (Array.isArray(current)) current = current[Number(key)];
		else if (isRecord(current)) current = current[key];
		else return undefined;
	}
	return current;
}

function restoreSensitiveSentinels(value: unknown, existing: unknown): unknown {
	if (value === REDACTED && existing !== undefined) return existing;
	if (Array.isArray(value))
		return value.map((entry, index) =>
			restoreSensitiveSentinels(entry, Array.isArray(existing) ? existing[index] : undefined),
		);
	if (isRecord(value)) {
		const old = isRecord(existing) ? existing : {};
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, restoreSensitiveSentinels(entry, old[key])]),
		);
	}
	return value;
}

function redactSensitive(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
	if (!isRecord(value)) {
		if (
			SENSITIVE_KEY.test(key) &&
			typeof value === "string" &&
			!/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value)
		)
			return REDACTED;
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([entryKey, entry]) => [entryKey, redactSensitive(entry, entryKey)]),
	);
}

function isWithin(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
}

function serializeSourceMutation<Result>(mutation: () => Promise<Result>): Promise<Result> {
	const result = sourceMutationQueue.then(mutation, mutation);
	sourceMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

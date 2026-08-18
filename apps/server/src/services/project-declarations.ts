import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	type Diagnostic,
	type ResolvedProjectConfig,
	resolveProjectConfigFromObject,
	validateProjectConfig,
} from "@openagentpack/sdk";
import { type Document, isMap, isNode, isSeq, type Pair, type ParsedNode, parseDocument, stringify } from "yaml";
import { type ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";

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
	source: string;
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
		"resources",
		"multiagent",
		"metadata",
		"environment_variables",
		"delivery",
	]),
	environment: new Set(["name", "description", "provider", "config", "metadata"]),
	skill: new Set(["name", "source", "description", "version", "origin", "provider"]),
	vault: new Set(["display_name", "provider", "credentials", "metadata"]),
	memory_store: new Set(["description", "provider", "metadata", "entries"]),
	file: new Set(["source", "name", "purpose", "provider"]),
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

export async function listProjectDeclarations(): Promise<{
	revision: string;
	resources: DeclarationResource[];
}>;
export async function listProjectDeclarations(manager: ProjectRuntimeManager): Promise<{
	revision: string;
	resources: DeclarationResource[];
}>;
export async function listProjectDeclarations(manager = projectRuntimeManager): Promise<{
	revision: string;
	resources: DeclarationResource[];
}> {
	const source = await readValidSource(manager);
	const config = documentObject(source.document);
	const resources: DeclarationResource[] = [];
	for (const type of DECLARATION_TYPES) {
		const section = recordValue(config[SECTION_BY_TYPE[type]]);
		for (const [id, declaration] of Object.entries(section)) {
			if (!isRecord(declaration)) continue;
			resources.push({
				type,
				id,
				declaration: redactSensitive(declaration) as Record<string, unknown>,
				read_only_paths: readOnlyPaths(type, declaration),
				references: findDeclarationReferences(config, type, id),
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
	const prepared = await prepareDeclarationChange(input, manager);
	return publicPreview(prepared);
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
		const prepared = await prepareDeclarationChange(input, manager);
		if (!prepared.can_commit) {
			const blockedByReferences = prepared.action === "delete" && prepared.references.length > 0;
			const status = blockedByReferences ? 409 : 422;
			const message = blockedByReferences
				? `Cannot delete ${prepared.type}.${prepared.id}; it is still referenced by ${prepared.references
						.map((reference) => reference.path)
						.join(", ")}.`
				: (prepared.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
					"The declaration change is invalid.");
			throw new DeclarationProtocolError(message, status);
		}

		const configPath = manager.configPath;
		const fileStat = await stat(configPath);
		const temporaryPath = resolve(
			dirname(configPath),
			`.${basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
		);
		try {
			await writeFile(temporaryPath, prepared.source, { encoding: "utf8", mode: fileStat.mode });
			if ((await manager.computeCurrentSourceRevision()) !== prepared.base_revision) {
				throw new DeclarationProtocolError("Project configuration changed. Reload before saving this edit.", 409);
			}
			await rename(temporaryPath, configPath);
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
		const newRevision = await manager.refreshAfterSourceMutation();
		if (!newRevision) throw new DeclarationProtocolError("The saved project has no revision.", 500);
		return { ...publicPreview(prepared), new_revision: newRevision };
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
	const source = await readValidSource(manager);
	if (source.revision !== input.baseRevision) {
		throw new DeclarationProtocolError("Project configuration changed. Reload before saving this edit.", 409);
	}
	const section = SECTION_BY_TYPE[input.type];
	const configBefore = documentObject(source.document);
	const declarationBefore = recordValue(configBefore[section])[input.id];
	if (!isRecord(declarationBefore)) {
		throw new DeclarationProtocolError(`${input.type}.${input.id} is not declared in agents.yaml.`, 404);
	}

	const document = source.document.clone();
	const references = findDeclarationReferences(configBefore, input.type, input.id);
	if (input.action === "delete") {
		document.deleteIn([section, input.id]);
		const remainingSection = document.get(section, true);
		if (isMap(remainingSection) && remainingSection.items.length === 0) document.delete(section);
	} else {
		const operations = input.operations ?? [];
		if (operations.length === 0) throw new DeclarationProtocolError("At least one patch operation is required.", 400);
		for (const operation of operations)
			applyPatch(document, section, input.id, input.type, declarationBefore, operation);
		const configAfterPatch = documentObject(document);
		const declarationAfter = recordValue(configAfterPatch[section])[input.id];
		if (!isRecord(declarationAfter))
			throw new DeclarationProtocolError("The patch removed the resource declaration.", 400);
		assertReadOnlyReferencesPreserved(input.type, declarationBefore, declarationAfter);
	}

	const configAfter = documentObject(document);
	const rawDiagnostics = await validateDocument(configAfter, manager.configPath);
	const knownSecrets = collectSensitiveStrings(configBefore, collectSensitiveStrings(configAfter));
	const diagnostics = redactKnownSecrets(redactSensitive(rawDiagnostics), knownSecrets) as Diagnostic[];
	const errors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
	return {
		type: input.type,
		id: input.id,
		action: input.action,
		base_revision: source.revision,
		before_yaml: declarationSnippet(input.id, declarationBefore),
		after_yaml:
			input.action === "delete"
				? "# declaration removed\n"
				: declarationSnippet(input.id, recordValue(configAfter[section])[input.id]),
		diagnostics,
		references,
		can_commit: !errors && (input.action !== "delete" || references.length === 0),
		source: renderDeclarationChange(
			source.raw,
			source.document,
			configAfter,
			section,
			input.id,
			input.action,
			input.operations ?? [],
		),
	};
}

async function readValidSource(manager: ProjectRuntimeManager): Promise<{
	revision: string;
	raw: string;
	document: Document<ParsedNode, true>;
}> {
	await manager.ensureStarted();
	const snapshot = manager.getSnapshot();
	if (snapshot.status !== "valid" || !snapshot.revision) {
		throw new DeclarationProtocolError(
			`Project configuration is ${snapshot.status}. Fix ${manager.configPath} before editing resources.`,
			422,
		);
	}
	const revisionBeforeRead = await manager.computeCurrentSourceRevision();
	const raw = await readFile(manager.configPath, "utf8");
	const revisionAfterRead = await manager.computeCurrentSourceRevision();
	if (revisionBeforeRead !== revisionAfterRead) {
		throw new DeclarationProtocolError("Project configuration changed. Reload before saving this edit.", 409);
	}
	const document = parseDocument(raw, { keepSourceTokens: true, prettyErrors: true });
	if (document.errors.length > 0) throw new DeclarationProtocolError(document.errors[0]!.message, 422);
	return { revision: revisionAfterRead, raw, document };
}

interface SourceEdit {
	start: number;
	end: number;
	replacement: string;
}

function renderDeclarationChange(
	source: string,
	document: Document<ParsedNode, true>,
	configAfter: Record<string, unknown>,
	section: string,
	id: string,
	action: "update" | "delete",
	operations: DeclarationPatchOperation[],
): string {
	if (action === "delete") return renderDeclarationDelete(source, document, section, id);
	const declarationAfter = recordValue(recordValue(configAfter[section])[id]);
	const resourceNode = document.getIn([section, id], true);
	if (!isMap(resourceNode)) throw new DeclarationProtocolError(`Cannot locate ${section}.${id} in agents.yaml.`, 422);

	const edits: SourceEdit[] = [];
	const additions: Array<[string, unknown]> = [];
	for (const field of new Set(operations.map((operation) => operation.path[0]!))) {
		const pair = findMapPair(resourceNode, field);
		const hasAfter = Object.hasOwn(declarationAfter, field);
		if (pair && hasAfter) {
			const range = parsedNodeRange(pair.value);
			const originalValue = source.slice(range[0], range[1]);
			edits.push({
				start: range[0],
				end: range[1],
				replacement: stringifyNodeValue(
					declarationAfter[field],
					pair.value,
					originalValue,
					lineIndent(source, range[0]),
				),
			});
		} else if (pair) {
			edits.push(pairSourceEdit(source, pair, ""));
		} else if (hasAfter) {
			additions.push([field, declarationAfter[field]]);
		}
	}

	if (additions.length > 0) {
		const range = parsedNodeRange(resourceNode);
		const indent = resourceFieldIndent(source, resourceNode, range[0]);
		const insertion = additions
			.map(([field, value]) => indentBlock(stringify({ [field]: value }, { lineWidth: 0 }), indent))
			.join("");
		const needsLeadingNewline = range[2] > 0 && source[range[2] - 1] !== "\n";
		edits.push({
			start: range[2],
			end: range[2],
			replacement: `${needsLeadingNewline ? "\n" : ""}${insertion}`,
		});
	}
	return applySourceEdits(source, edits);
}

function renderDeclarationDelete(
	source: string,
	document: Document<ParsedNode, true>,
	section: string,
	id: string,
): string {
	const sectionNode = document.get(section, true);
	if (!isMap(sectionNode))
		throw new DeclarationProtocolError(`Cannot locate section '${section}' in agents.yaml.`, 422);
	const resourcePair = findMapPair(sectionNode, id);
	if (!resourcePair) throw new DeclarationProtocolError(`Cannot locate ${section}.${id} in agents.yaml.`, 422);
	if (sectionNode.items.length > 1) return applySourceEdits(source, [pairSourceEdit(source, resourcePair, "")]);

	const root = document.contents;
	if (!isMap(root)) throw new DeclarationProtocolError("agents.yaml must contain a mapping at its root.", 422);
	const sectionPair = findMapPair(root, section);
	if (!sectionPair) throw new DeclarationProtocolError(`Cannot locate section '${section}' in agents.yaml.`, 422);
	return applySourceEdits(source, [pairSourceEdit(source, sectionPair, "")]);
}

function findMapPair(map: unknown, key: string): Pair | undefined {
	if (!isMap(map)) return undefined;
	return map.items.find((pair) => nodeScalarValue(pair.key) === key);
}

function nodeScalarValue(value: unknown): string | undefined {
	if (!isNode(value) || !("value" in value)) return undefined;
	return typeof value.value === "string" ? value.value : String(value.value);
}

function parsedNodeRange(value: unknown): [number, number, number] {
	if (!isNode(value) || !("range" in value) || !Array.isArray(value.range) || value.range.length !== 3) {
		throw new DeclarationProtocolError("The target YAML node has no editable source range.", 422);
	}
	return value.range as [number, number, number];
}

function pairSourceEdit(source: string, pair: Pair, replacement: string): SourceEdit {
	const keyRange = parsedNodeRange(pair.key);
	const valueRange = pair.value === null ? keyRange : parsedNodeRange(pair.value);
	return {
		start: source.lastIndexOf("\n", keyRange[0] - 1) + 1,
		end: Math.max(keyRange[2], valueRange[2]),
		replacement,
	};
}

function stringifyNodeValue(value: unknown, originalNode: unknown, originalValue: string, indent: number): string {
	const originalIsBlockCollection = (isMap(originalNode) || isSeq(originalNode)) && !originalNode.flow;
	const valueIsCollection = Array.isArray(value) || isRecord(value);
	const collectionStyle = originalIsBlockCollection ? "block" : valueIsCollection ? "flow" : "any";
	const paddedFlow = /^[[{]\s/.test(originalValue);
	let rendered = stringify(value, {
		collectionStyle,
		flowCollectionPadding: paddedFlow,
		lineWidth: 0,
	});
	if (!originalValue.endsWith("\n")) rendered = rendered.replace(/\n$/, "");
	return rendered.replace(/\n(?=.)/g, `\n${" ".repeat(indent)}`);
}

function resourceFieldIndent(source: string, resourceNode: unknown, fallbackOffset: number): number {
	if (isMap(resourceNode)) {
		const firstPair = resourceNode.items[0];
		if (firstPair) return lineIndent(source, parsedNodeRange(firstPair.key)[0]);
	}
	return lineIndent(source, fallbackOffset) + 2;
}

function lineIndent(source: string, offset: number): number {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	let cursor = lineStart;
	while (source[cursor] === " ") cursor++;
	return cursor - lineStart;
}

function indentBlock(value: string, indent: number): string {
	const prefix = " ".repeat(indent);
	return value
		.split(/(?<=\n)/)
		.map((line) => (line === "" ? line : `${prefix}${line}`))
		.join("");
}

function applySourceEdits(source: string, edits: SourceEdit[]): string {
	const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
	let rendered = source;
	let previousStart = source.length + 1;
	for (const edit of ordered) {
		if (edit.end > previousStart) throw new DeclarationProtocolError("Patch operations overlap in agents.yaml.", 400);
		rendered = `${rendered.slice(0, edit.start)}${edit.replacement}${rendered.slice(edit.end)}`;
		previousStart = edit.start;
	}
	return rendered;
}

function applyPatch(
	document: Document<ParsedNode, true>,
	section: string,
	id: string,
	type: DeclarationType,
	declarationBefore: Record<string, unknown>,
	operation: DeclarationPatchOperation,
): void {
	if (operation.path.length === 0 || operation.path.some((entry) => !entry.trim())) {
		throw new DeclarationProtocolError("Patch paths must contain non-empty field names.", 400);
	}
	const topLevelField = operation.path[0]!;
	if (!EDITABLE_FIELDS[type].has(topLevelField)) {
		throw new DeclarationProtocolError(`Field '${topLevelField}' is not editable for ${type} resources.`, 400);
	}
	const targetPath = [section, id, ...operation.path];
	if (operation.op === "remove") {
		document.deleteIn(targetPath);
		return;
	}
	const existingValue = valueAtPath(declarationBefore, operation.path);
	document.setIn(targetPath, restoreSensitiveSentinels(operation.value, existingValue));
}

function assertReadOnlyReferencesPreserved(
	type: DeclarationType,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): void {
	if (type === "agent" && typeof before.instructions === "string" && isLocalReference(before.instructions)) {
		if (after.instructions !== before.instructions) {
			throw new DeclarationProtocolError("File-backed Agent instructions are read-only in Workbench.", 400);
		}
	}
	if ((type === "skill" || type === "file") && typeof before.source === "string" && isLocalReference(before.source)) {
		if (after.source !== before.source) {
			throw new DeclarationProtocolError(`File-backed ${type} sources are read-only in Workbench.`, 400);
		}
	}
	if (type !== "memory_store") return;
	const afterEntries = Array.isArray(after.entries) ? after.entries : [];
	for (const entry of Array.isArray(before.entries) ? before.entries : []) {
		if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.content !== "string") continue;
		if (!isLocalReference(entry.content)) continue;
		const matching = afterEntries.find((candidate) => isRecord(candidate) && candidate.key === entry.key);
		if (!isRecord(matching) || matching.content !== entry.content) {
			throw new DeclarationProtocolError(`File-backed memory entry '${entry.key}' is read-only in Workbench.`, 400);
		}
	}
}

async function validateDocument(config: Record<string, unknown>, configPath: string): Promise<Diagnostic[]> {
	try {
		const loaded = await resolveProjectConfigFromObject(config, {
			projectName: basename(dirname(configPath)),
			basePath: dirname(configPath),
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
		if (type === "skill" && agent.skills?.some((skill) => skill === id))
			add("agent", agentId, `agents.${agentId}.skills`);
		if (type === "vault" && agent.vault === id) add("agent", agentId, `agents.${agentId}.vault`);
		if (type === "memory_store" && agent.memory_stores?.includes(id)) {
			add("agent", agentId, `agents.${agentId}.memory_stores`);
		}
		if (type === "agent" && agentId !== id && agent.multiagent?.agents.includes(id)) {
			add("agent", agentId, `agents.${agentId}.multiagent.agents`);
		}
	}
	if (type === "agent") {
		for (const [channelId, channel] of Object.entries(resolved.channels ?? {})) {
			if (channel.agent === id) add("channel", channelId, `channels.${channelId}.agent`);
		}
	}
	for (const [deploymentId, deployment] of Object.entries(resolved.deployments ?? {})) {
		if (type === "agent" && deployment.agent === id)
			add("deployment", deploymentId, `deployments.${deploymentId}.agent`);
		if (type === "environment" && deployment.environment === id) {
			add("deployment", deploymentId, `deployments.${deploymentId}.environment`);
		}
		if (type === "vault" && deployment.vaults?.includes(id)) {
			add("deployment", deploymentId, `deployments.${deploymentId}.vaults`);
		}
		if (type === "memory_store") {
			if (deployment.memory_stores?.includes(id)) {
				add("deployment", deploymentId, `deployments.${deploymentId}.memory_stores`);
			}
			if (deployment.resources?.some((resource) => resource.type === "memory_store" && resource.memory_store === id)) {
				add("deployment", deploymentId, `deployments.${deploymentId}.resources`);
			}
		}
	}
	return references;
}

function readOnlyPaths(type: DeclarationType, declaration: Record<string, unknown>): string[][] {
	const paths: string[][] = [];
	if (type === "environment" && declaration.environment_id !== undefined) paths.push(["environment_id"]);
	if (type === "agent" && typeof declaration.instructions === "string" && isLocalReference(declaration.instructions)) {
		paths.push(["instructions"]);
	}
	if (
		(type === "skill" || type === "file") &&
		typeof declaration.source === "string" &&
		isLocalReference(declaration.source)
	) {
		paths.push(["source"]);
	}
	if (type === "memory_store" && Array.isArray(declaration.entries)) {
		declaration.entries.forEach((entry, index) => {
			if (isRecord(entry) && typeof entry.content === "string" && isLocalReference(entry.content)) {
				paths.push(["entries", String(index), "content"]);
			}
		});
	}
	return paths;
}

function publicPreview(prepared: PreparedDeclarationChange): DeclarationPreview {
	const { source: _source, ...preview } = prepared;
	return preview;
}

function declarationSnippet(id: string, declaration: unknown): string {
	return stringify({ [id]: redactSensitive(declaration) }, { lineWidth: 0 });
}

function documentObject(document: Document<ParsedNode, true>): Record<string, unknown> {
	const value = document.toJS({ mapAsMap: false });
	if (!isRecord(value)) throw new DeclarationProtocolError("agents.yaml must contain a mapping at its root.", 422);
	return value;
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: string[]): unknown {
	let current = value;
	for (const entry of path) {
		if (Array.isArray(current)) current = current[Number(entry)];
		else if (isRecord(current)) current = current[entry];
		else return undefined;
	}
	return current;
}

function restoreSensitiveSentinels(value: unknown, existing: unknown): unknown {
	if (value === REDACTED && existing !== undefined) return existing;
	if (Array.isArray(value)) {
		return value.map((entry, index) =>
			restoreSensitiveSentinels(entry, Array.isArray(existing) ? existing[index] : undefined),
		);
	}
	if (isRecord(value)) {
		const existingRecord = isRecord(existing) ? existing : {};
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, restoreSensitiveSentinels(entry, existingRecord[key])]),
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
		) {
			return REDACTED;
		}
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([entryKey, entry]) => [entryKey, redactSensitive(entry, entryKey)]),
	);
}

function collectSensitiveStrings(value: unknown, secrets = new Set<string>(), key = ""): Set<string> {
	if (Array.isArray(value)) {
		for (const entry of value) collectSensitiveStrings(entry, secrets);
		return secrets;
	}
	if (isRecord(value)) {
		for (const [entryKey, entry] of Object.entries(value)) collectSensitiveStrings(entry, secrets, entryKey);
		return secrets;
	}
	if (
		SENSITIVE_KEY.test(key) &&
		typeof value === "string" &&
		value.length > 0 &&
		value !== REDACTED &&
		!isEnvironmentReference(value)
	) {
		secrets.add(value);
	}
	return secrets;
}

function redactKnownSecrets(value: unknown, secrets: Set<string>): unknown {
	if (Array.isArray(value)) return value.map((entry) => redactKnownSecrets(entry, secrets));
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactKnownSecrets(entry, secrets)]));
	}
	if (typeof value !== "string") return value;
	let redacted = value;
	for (const secret of secrets) redacted = redacted.replaceAll(secret, REDACTED);
	return redacted;
}

function isEnvironmentReference(value: string): boolean {
	return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value);
}

function isLocalReference(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}

function serializeSourceMutation<T>(mutation: () => Promise<T>): Promise<T> {
	const result = sourceMutationQueue.then(mutation, mutation);
	sourceMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

import { basename, dirname } from "node:path";
import { isScalar, parseDocument, visit } from "yaml";
import { resolveProjectConfigFromObject } from "../parser/resolve-project-config.ts";
import type { Diagnostic } from "../types/dto.ts";
import { validateProjectConfig } from "./validate-config.ts";

const REDACTED = "[redacted]";
const ENVIRONMENT_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SENSITIVE_KEY =
	/(access[_-]?key(?:[_-]?id)?|api[_-]?key|authorization|credential|headers?|password|secret(?![_-]?name)|signature|token)/i;

export interface ProjectSourceInspection {
	diagnostics: Diagnostic[];
	redacted_source: string;
	sensitive_literals: string[];
}

/** Validates a complete agents.yaml source and produces a display-safe copy. */
export async function inspectProjectSource(source: string, configPath: string): Promise<ProjectSourceInspection> {
	const document = parseDocument(source, { keepSourceTokens: true, prettyErrors: true });
	if (document.errors.length > 0) {
		return {
			diagnostics: document.errors.map(() => ({
				severity: "error" as const,
				code: "project.config.invalid",
				message: "agents.yaml contains invalid YAML. Fix the syntax before creating or restoring a version.",
			})),
			redacted_source: "# Invalid agents.yaml source omitted from the safe preview.\n",
			sensitive_literals: [],
		};
	}

	const rawConfig = document.toJS({ mapAsMap: false });
	const displaySecrets = collectSensitiveScalars(rawConfig);
	const sensitiveLiterals = [...displaySecrets].filter((value) => !ENVIRONMENT_REFERENCE.test(value));
	let diagnostics: Diagnostic[];
	try {
		const loaded = await resolveProjectConfigFromObject(rawConfig, {
			projectName: basename(dirname(configPath)),
			basePath: dirname(configPath),
		});
		diagnostics = validateProjectConfig(loaded.config);
	} catch (error) {
		diagnostics = [
			{
				severity: "error",
				code: "project.config.invalid",
				message: error instanceof Error ? error.message : String(error),
			},
		];
	}

	if (sensitiveLiterals.length > 0) {
		diagnostics.push({
			severity: "error",
			code: "project.version.sensitive_literal",
			message:
				"agents.yaml contains a credential value in a sensitive field. Replace it with an environment variable reference before creating or restoring a version.",
		});
	}

	return {
		diagnostics: redactDiagnostics(diagnostics, displaySecrets),
		redacted_source: redactDocumentSource(source, document, displaySecrets),
		sensitive_literals: sensitiveLiterals.map(() => REDACTED),
	};
}

function collectSensitiveScalars(
	value: unknown,
	result = new Set<string>(),
	key = "",
	ancestorSensitive = false,
): Set<string> {
	if (Array.isArray(value)) {
		const nestedSensitive = ancestorSensitive || isSensitiveValueKey(key);
		for (const entry of value) collectSensitiveScalars(entry, result, key, nestedSensitive);
		return result;
	}
	if (isRecord(value)) {
		const nestedSensitive = ancestorSensitive || isSensitiveContainerKey(key);
		for (const [entryKey, entry] of Object.entries(value)) {
			collectSensitiveScalars(entry, result, entryKey, nestedSensitive);
		}
		return result;
	}
	if (
		(ancestorSensitive || isSensitiveValueKey(key)) &&
		(typeof value === "string" || typeof value === "number") &&
		String(value).length > 0
	) {
		result.add(String(value));
	}
	return result;
}

function isSensitiveContainerKey(key: string): boolean {
	return ["header", "headers", "authorization"].includes(key.toLowerCase().replaceAll("-", "_"));
}

function isSensitiveValueKey(key: string): boolean {
	const normalized = key.toLowerCase().replaceAll("-", "_");
	if (normalized === "secret_name" || normalized === "credentials") return false;
	return SENSITIVE_KEY.test(normalized);
}

function redactDocumentSource(
	source: string,
	document: ReturnType<typeof parseDocument>,
	secrets: Set<string>,
): string {
	if (secrets.size === 0) return source;
	const redactedDocument = document.clone();
	visit(redactedDocument, (_key, node) => {
		if (isScalar(node) && (typeof node.value === "string" || typeof node.value === "number")) {
			const value = String(node.value);
			const redacted = redactText(value, secrets);
			if (redacted !== value) {
				node.value = redacted;
				node.source = redacted;
				node.type = "PLAIN";
			}
		}
		redactComments(node, secrets);
	});
	redactComments(redactedDocument, secrets);
	return redactedDocument.toString();
}

function redactText(source: string, secrets: Set<string>): string {
	let redacted = source;
	for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
		redacted = redacted.replaceAll(secret, REDACTED);
	}
	return redacted;
}

function redactComments(value: unknown, secrets: Set<string>): void {
	if (!value || typeof value !== "object") return;
	const commented = value as { comment?: string | null; commentBefore?: string | null };
	if (commented.comment) commented.comment = redactText(commented.comment, secrets);
	if (commented.commentBefore) commented.commentBefore = redactText(commented.commentBefore, secrets);
}

function redactDiagnostics(diagnostics: Diagnostic[], secrets: Set<string>): Diagnostic[] {
	return diagnostics.map((diagnostic) => ({
		...diagnostic,
		message: redactText(diagnostic.message, secrets),
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

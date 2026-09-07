import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as nodeUtil from "node:util";
import { UserError } from "@openagentpack/sdk";
import type { ProjectSourceFile } from "./index.ts";
import { RESOURCE_EXAMPLES_DIRECTORY } from "./scaffold.ts";

const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const VAULT_PATH = /^(?:agents\/[^/]+\/vaults|resources\/vaults)\/[^/]+\/vault\.json$/;

export interface VaultSecretMigration {
	overrides: Map<string, Record<string, unknown>>;
	literals: string[];
	count: number;
	envBefore: string | null;
	envAfter: string | null;
}

/** Plan from the scanned source, without ever writing secrets during Preview. */
export async function planVaultSecretMigration(
	root: string,
	files: ProjectSourceFile[],
): Promise<VaultSecretMigration> {
	const plan: VaultSecretMigration = { overrides: new Map(), literals: [], count: 0, envBefore: null, envAfter: null };
	const candidates: Array<{
		path: string;
		metadata: Record<string, unknown>;
		credential: Record<string, unknown>;
		field: string;
		value: string;
	}> = [];
	for (const file of files.filter(
		(candidate) =>
			VAULT_PATH.test(candidate.path) && !candidate.path.includes(`/vaults/${RESOURCE_EXAMPLES_DIRECTORY}/`),
	)) {
		let metadata: Record<string, unknown>;
		try {
			metadata = JSON.parse(Buffer.from(file.content).toString("utf8"));
		} catch {
			throw new UserError(`${file.path}: invalid JSON; source omitted. / JSON 无效，已隐藏源内容。`);
		}
		if (!isRecord(metadata) || !Array.isArray(metadata.credentials)) continue;
		for (const credential of metadata.credentials) {
			if (!isRecord(credential)) continue;
			// Normalize sensitive fields even in an incomplete credential. Schema
			// validation still blocks writes, but its Preview must never expose them.
			for (const field of ["secret_value", "access_token"]) {
				const value = credential[field];
				if (
					(typeof value !== "string" && typeof value !== "number") ||
					String(value) === "" ||
					ENV_REFERENCE.test(String(value))
				)
					continue;
				candidates.push({ path: file.path, metadata, credential, field, value: String(value) });
			}
		}
	}
	if (candidates.length === 0) return plan;
	plan.envBefore = await readProjectDotEnv(root);
	const existing = parseProjectDotEnv(plan.envBefore ?? "");
	let content = plan.envBefore ?? "";
	for (const candidate of candidates) {
		const identity = `${String(candidate.metadata.id)}\0${String(candidate.credential.name)}\0${candidate.field}`;
		const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12).toUpperCase();
		const label = `${String(candidate.metadata.id)}_${String(candidate.credential.name)}_${candidate.field}`
			.replace(/[^A-Za-z0-9_]/g, "_")
			.toUpperCase()
			.slice(0, 80);
		const baseName = `AGENTS_VAULT_${label}_${suffix}`;
		let variable = baseName;
		let sequence = 2;
		while (
			(existing[variable] !== undefined && existing[variable] !== candidate.value) ||
			(process.env[variable] !== undefined && process.env[variable] !== candidate.value)
		) {
			variable = `${baseName}_${sequence++}`;
		}
		if (existing[variable] === undefined) {
			const assignment = encodeAssignment(variable, candidate.value);
			if (content && !content.endsWith("\n")) content += "\n";
			content += assignment;
			existing[variable] = candidate.value;
		}
		candidate.credential[candidate.field] = `\${${variable}}`;
		plan.overrides.set(candidate.path, candidate.metadata);
		plan.literals.push(candidate.value);
		plan.count++;
	}
	// Ensure an existing malformed/unterminated entry cannot swallow an appended value.
	const verified = parseProjectDotEnv(content);
	for (const [name, value] of Object.entries(existing)) {
		if (verified[name] !== value)
			throw new UserError("Cannot safely append to project .env. Fix its syntax first. / 请先修复项目 .env 的语法。");
	}
	plan.envAfter = content;
	return plan;
}

export async function applyVaultSecretMigration(
	root: string,
	files: ProjectSourceFile[],
	plan: VaultSecretMigration,
): Promise<void> {
	if (plan.count === 0) return;
	const assertEnvironmentUnchanged = async () => {
		if ((await readProjectDotEnv(root)) !== plan.envBefore)
			throw new UserError("Project .env changed. Preview Build again. / .env 已变化，请重新预览构建。");
	};
	await assertEnvironmentUnchanged();
	const sourceByPath = new Map(files.map((file) => [file.path, file]));
	for (const path of plan.overrides.keys()) await assertUnchanged(root, sourceByPath.get(path)!);
	// Persist the only remaining copy of each secret BEFORE replacing its JSON value.
	// If a later JSON write fails, .env is retained and a retry reuses its entries.
	await writePrivateAtomic(resolve(root, ".env"), plan.envAfter!, 0o600, assertEnvironmentUnchanged);
	for (const [path, metadata] of plan.overrides) {
		const source = sourceByPath.get(path)!;
		await assertUnchanged(root, source);
		await writePrivateAtomic(resolve(root, path), `${JSON.stringify(metadata, null, 2)}\n`, source.mode, () =>
			assertUnchanged(root, source),
		);
	}
}

/** Read only this project's .env; never search a parent or mutate process.env. */
export async function readProjectEnvironment(root: string): Promise<Record<string, string>> {
	return parseProjectDotEnv((await readProjectDotEnv(root)) ?? "");
}

async function readProjectDotEnv(root: string): Promise<string | null> {
	const path = resolve(root, ".env");
	try {
		const details = await lstat(path);
		if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe file");
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return null;
		throw new UserError(
			"Project .env must be a readable regular file, not a symlink. / 项目 .env 必须是可读的普通文件，不能是符号链接。",
		);
	}
}

function parseProjectDotEnv(content: string): Record<string, string> {
	try {
		const parsed = parsePortableDotEnv(content);
		if (typeof nodeUtil.parseEnv === "function") {
			const native = nodeUtil.parseEnv(content);
			if (JSON.stringify(Object.entries(parsed).sort()) !== JSON.stringify(Object.entries(native).sort()))
				throw new Error("ambiguous syntax");
		}
		return parsed;
	} catch {
		throw new UserError("Cannot parse project .env; contents omitted. / 无法解析项目 .env，已隐藏内容。");
	}
}

/** Strict portable dotenv subset, also usable by hosts running Node 18. */
function parsePortableDotEnv(content: string): Record<string, string> {
	const values: Record<string, string> = Object.create(null);
	let remaining = content.replace(/\r\n?/g, "\n");
	while (remaining.trim()) {
		remaining = remaining.trimStart();
		if (remaining.startsWith("#")) {
			remaining = remaining.slice(remaining.indexOf("\n") < 0 ? remaining.length : remaining.indexOf("\n") + 1);
			continue;
		}
		const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=[ \t]*/.exec(remaining);
		if (!assignment) throw new Error("invalid assignment");
		remaining = remaining.slice(assignment[0].length);
		let value: string;
		const delimiter = remaining[0];
		if (["'", '"', "`"].includes(delimiter ?? "")) {
			const end = remaining.indexOf(delimiter!, 1);
			if (end < 0) throw new Error("unterminated value");
			value = remaining.slice(1, end);
			if (delimiter === '"') value = value.replaceAll("\\n", "\n");
			remaining = remaining.slice(end + 1);
			const tail = remaining.split("\n", 1)[0]!;
			if (tail.trim() && !tail.trimStart().startsWith("#")) throw new Error("trailing value");
		} else {
			value = remaining.split("\n", 1)[0]!.split("#", 1)[0]!.trim();
		}
		values[assignment[1]!] = value;
		const newline = remaining.indexOf("\n");
		remaining = newline < 0 ? "" : remaining.slice(newline + 1);
	}
	return values;
}

function encodeAssignment(name: string, value: string): string {
	// Native dotenv has no general escape syntax. Choose a lossless delimiter and
	// verify the round trip (including #, $, backslashes and multiline values).
	for (const quote of ["'", '"', "`"]) {
		if (value.includes(quote) || value.includes("\0")) continue;
		const assignment = `${name}=${quote}${value}${quote}\n`;
		try {
			if (parseProjectDotEnv(assignment)[name] === value) return assignment;
		} catch {
			/* Try the next delimiter. */
		}
	}
	throw new UserError(
		"A Vault secret cannot be represented losslessly in .env. Supply an environment variable reference instead. / Vault 密钥无法无损写入 .env，请改用环境变量引用。",
	);
}

async function assertUnchanged(root: string, source: ProjectSourceFile): Promise<void> {
	const path = resolve(root, source.path);
	const details = await lstat(path);
	if (
		!details.isFile() ||
		details.isSymbolicLink() ||
		(details.mode & 0o777) !== source.mode ||
		!Buffer.from(source.content).equals(await readFile(path))
	) {
		throw new UserError("Vault source changed. Preview Build again. / Vault 源文件已变化，请重新预览构建。");
	}
}

async function writePrivateAtomic(
	path: string,
	content: string,
	mode: number,
	beforeRename: () => Promise<void>,
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		await chmod(temporary, mode);
		await beforeRename();
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export function redactVaultText(text: string, literals: string[]): string {
	let redacted = text;
	for (const literal of [...new Set(literals)].sort((left, right) => right.length - left.length))
		redacted = redacted.replaceAll(literal, "[redacted]");
	return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === code;
}

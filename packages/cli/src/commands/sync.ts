import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { SecretPlaceholder, SyncProjectResult } from "@openagentpack/sdk";
import {
	resolveSyncProvider,
	syncProviderResourcesFromContext,
	syncProviderResourcesFromEnv,
	UserError,
} from "@openagentpack/sdk";
import { stringify as stringifyYaml } from "yaml";
import { buildCliRuntime } from "../config-loader.ts";
import { ensureCredentials } from "../credentials.ts";
import { log } from "../logger.ts";
import { fileExistsSync } from "../utils/file-utils.ts";

const DEFAULT_SYNC_OUTPUT = "agents.synced.yaml";

/** Refuse to overwrite an existing sync output file unless --force is set. */
export function ensureSyncOutputWritable(outPath: string, force?: boolean): void {
	if (force) return;
	if (fileExistsSync(outPath)) {
		throw new UserError(
			`Output file '${outPath}' already exists. Use --force to overwrite, or -o/--out to write elsewhere.`,
		);
	}
}

export async function syncCommand(options: { file: string; provider?: string; out?: string; force?: boolean }) {
	const outPath = options.out ?? DEFAULT_SYNC_OUTPUT;
	ensureSyncOutputWritable(outPath, options.force);

	const configPath = resolve(options.file);
	const { provider, result } = fileExistsSync(configPath)
		? await syncFromConfig(configPath, options.provider)
		: await syncFromEnv(options.provider);

	const baseDir = dirname(outPath);

	// Interactive file path association (before writing yaml — skipped files are removed)
	const removedFiles = await promptFileAssociation(result.config, baseDir);
	if (removedFiles.length > 0) {
		const files = (result.config.files ?? {}) as Record<string, unknown>;
		for (const key of removedFiles) {
			delete files[key];
		}
		if (Object.keys(files).length === 0) {
			delete result.config.files;
		}
	}

	// Serialize config to yaml (use JSON roundtrip for simple re-serialization)
	const yamlContent = removedFiles.length > 0 ? await serializeConfig(result.config) : result.yaml;
	await writeFile(outPath, yamlContent, "utf8");

	// Write downloaded skill files to disk
	if (result.skillFiles?.size) {
		let skillFileCount = 0;
		for (const [skillName, files] of result.skillFiles) {
			const skillDir = join(baseDir, "skills", skillName);
			for (const file of files) {
				const filePath = join(skillDir, file.relativePath);
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, file.content);
				skillFileCount++;
			}
		}
		log.info(`Downloaded ${result.skillFiles.size} skill(s) (${skillFileCount} files) into ./skills/`);
	}

	const parts: string[] = [];
	for (const [type, count] of Object.entries(result.counts)) {
		parts.push(`${count} ${type}(s)`);
	}
	log.success(`Synced ${parts.join(", ")} from ${provider} into ${outPath}.`);

	// Interactive skill file upload for custom skills that weren't downloaded
	await promptCustomSkillFiles(result.config, baseDir);

	// Interactive secret input for vault credentials
	if (result.secretPlaceholders?.length) {
		await promptSecretValues(result.secretPlaceholders);
	}
}

async function syncFromConfig(
	configPath: string,
	explicitProvider?: string,
): Promise<{ provider: string; result: SyncProjectResult }> {
	const ctx = await buildCliRuntime(configPath);
	const provider = resolveSyncProvider(ctx.config, explicitProvider);
	const result = await syncProviderResourcesFromContext(ctx, { provider });
	return { provider, result };
}

async function syncFromEnv(explicitProvider?: string): Promise<{ provider: string; result: SyncProjectResult }> {
	if (!explicitProvider) {
		throw new UserError(
			"agents sync requires --provider when no config file exists, e.g. `agents sync --provider claude`.",
		);
	}
	ensureCredentials();
	const result = await syncProviderResourcesFromEnv({ provider: explicitProvider });
	return { provider: explicitProvider, result };
}

async function promptSecretValues(placeholders: SecretPlaceholder[]): Promise<void> {
	p.note(
		"Vault credentials contain secret placeholders.\nEnter values below (stored locally in .env, never uploaded). Press Enter to skip.",
		"Secrets",
	);

	const envPath = ".env";
	const existingEnv = loadExistingEnv(envPath);
	let written = 0;
	let skipped = 0;

	for (const ph of placeholders) {
		// Skip if already set in .env
		if (existingEnv.has(ph.envVar)) {
			skipped++;
			continue;
		}

		const value = await p.password({
			message: `${ph.vaultName} / ${ph.credentialName} [${ph.envVar}]`,
		});

		if (p.isCancel(value)) {
			log.info("Cancelled. Remaining secrets skipped.");
			break;
		}

		const trimmed = (value ?? "").trim();
		appendEnvLine(envPath, ph.envVar, trimmed);
		if (trimmed) {
			written++;
		} else {
			skipped++;
		}
	}

	if (written > 0 || skipped > 0) {
		const msg: string[] = [];
		if (written > 0) msg.push(`${written} secret(s) written to .env`);
		if (skipped > 0) msg.push(`${skipped} skipped`);
		log.info(msg.join(", ") + ".");
	}
}

function loadExistingEnv(path: string): Set<string> {
	const keys = new Set<string>();
	if (!fileExistsSync(path)) return keys;
	const content = readFileSync(path, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx > 0) {
			keys.add(trimmed.slice(0, eqIdx).trim());
		}
	}
	return keys;
}

function appendEnvLine(path: string, key: string, value: string): void {
	let content = "";
	if (fileExistsSync(path)) {
		content = readFileSync(path, "utf8");
		if (content.length > 0 && !content.endsWith("\n")) {
			content += "\n";
		}
	}
	content += `${key}=${value}\n`;
	writeFileSync(path, content);
}

async function promptCustomSkillFiles(config: Record<string, unknown>, baseDir: string): Promise<void> {
	const skills = (config.skills ?? {}) as Record<string, Record<string, unknown>>;

	// Collect custom skills whose source directory/file is missing or empty
	const missing: Array<{
		key: string;
		name: string;
		dir: string;
		decl: Record<string, unknown>;
	}> = [];
	for (const [key, decl] of Object.entries(skills)) {
		if (decl.origin !== "custom") continue;
		const skillName = (decl.name as string) ?? key;
		const skillSource = join(baseDir, decl.source as string);
		// Check if source exists (directory with files, or zip file)
		if (fileExistsSync(skillSource)) {
			const stat = statSync(skillSource);
			if (stat.isFile()) continue; // zip or single file already present
			if (stat.isDirectory() && readdirSync(skillSource).length > 0) continue;
		}
		missing.push({ key, name: skillName, dir: skillSource, decl });
	}

	if (missing.length === 0) return;

	p.note(
		"Some custom skills could not be downloaded.\nProvide a local path to the skill directory, or press Enter to create an empty placeholder.",
		"Skills",
	);

	let provided = 0;
	let skippedCount = 0;

	for (const skill of missing) {
		const sourcePath = await p.text({
			message: `Skill "${skill.name}" — local path (or Enter to skip):`,
			placeholder: "./path/to/skill/",
		});

		if (p.isCancel(sourcePath)) {
			log.info("Cancelled. Remaining skills skipped.");
			break;
		}

		const trimmed = (sourcePath ?? "").trim();
		if (trimmed && fileExistsSync(trimmed)) {
			const stat = statSync(trimmed);
			if (stat.isDirectory()) {
				// Copy directory contents to skill dir
				copyDirRecursive(trimmed, skill.dir);
				provided++;
			} else if (stat.isFile() && trimmed.endsWith(".zip")) {
				// Zip file — copy into skill dir (resolveSkillFiles will find and extract it)
				mkdirSync(skill.dir, { recursive: true });
				copyFileSync(trimmed, join(skill.dir, basename(trimmed)));
				// Update source to point to the zip inside the skill dir
				skill.decl.source = `./skills/${skill.name}/${basename(trimmed)}`;
				provided++;
			} else if (stat.isFile()) {
				// Single file — put into skill dir
				mkdirSync(skill.dir, { recursive: true });
				copyFileSync(trimmed, join(skill.dir, basename(trimmed)));
				provided++;
			} else {
				createEmptySkill(skill.dir, skill.name);
				skippedCount++;
			}
		} else {
			// Skip — create empty placeholder
			createEmptySkill(skill.dir, skill.name);
			skippedCount++;
		}
	}

	if (provided > 0 || skippedCount > 0) {
		const msg: string[] = [];
		if (provided > 0) msg.push(`${provided} skill(s) provided`);
		if (skippedCount > 0) msg.push(`${skippedCount} skipped (empty placeholder created)`);
		log.info(msg.join(", ") + ".");
	}
}

function createEmptySkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	if (!fileExistsSync(join(dir, "SKILL.md"))) {
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: ""\n---\n\n# ${name}\n\n> **NOTE**: This is a placeholder file generated by \`agents sync\`. It does NOT contain your original skill content.\n> Please replace this file with the actual skill definition, then run \`agents apply\` to upload it.\n`,
		);
	}
}

function copyDirRecursive(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

async function promptFileAssociation(config: Record<string, unknown>, baseDir: string): Promise<string[]> {
	const files = (config.files ?? {}) as Record<string, Record<string, unknown>>;
	const fileEntries = Object.entries(files);
	if (fileEntries.length === 0) return [];

	p.note(
		"Files cannot be downloaded from the remote platform.\nProvide a local file path, or press Enter to skip (file will be removed from sync).",
		"Files",
	);

	const removed: string[] = [];
	let provided = 0;

	for (const [key, decl] of fileEntries) {
		const fileName = (decl.name as string) ?? (decl.source as string) ?? key;
		const targetPath = join(baseDir, decl.source as string);

		// Skip if file already exists locally
		if (fileExistsSync(targetPath)) {
			provided++;
			continue;
		}

		const sourcePath = await p.text({
			message: `File "${fileName}" — local path (or Enter to skip/remove):`,
			placeholder: "./path/to/file",
		});

		if (p.isCancel(sourcePath)) {
			log.info("Cancelled. Remaining files skipped and removed.");
			// Remove all remaining
			for (const [remainingKey] of fileEntries.slice(fileEntries.indexOf([key, decl]))) {
				removed.push(remainingKey);
			}
			break;
		}

		const trimmed = (sourcePath ?? "").trim();
		if (trimmed && fileExistsSync(trimmed)) {
			// Copy the file to the expected source location
			mkdirSync(dirname(targetPath), { recursive: true });
			copyFileSync(trimmed, targetPath);
			provided++;
		} else {
			// Skip — remove from config
			removed.push(key);
		}
	}

	if (provided > 0 || removed.length > 0) {
		const msg: string[] = [];
		if (provided > 0) msg.push(`${provided} file(s) associated`);
		if (removed.length > 0) msg.push(`${removed.length} removed (skipped)`);
		log.info(msg.join(", ") + ".");
	}

	return removed;
}

async function serializeConfig(config: Record<string, unknown>): Promise<string> {
	return stringifyYaml(config, { lineWidth: 0 });
}

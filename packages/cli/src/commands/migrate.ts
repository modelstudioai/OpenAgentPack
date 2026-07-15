import { writeFile } from "node:fs/promises";
import { migrateConfig, UserError } from "@openagentpack/sdk";
import { log } from "../logger.ts";
import { fileExists } from "../utils/file-utils.ts";

export async function migrateCommand(options: { from?: string; to?: string }) {
	const fromPath = options.from ?? "agents.synced.yaml";
	const toPath = options.to ?? "agents.yaml";

	// Auto-create target agents.yaml if it doesn't exist
	const toExists = await fileExists(toPath);
	if (!toExists) {
		throw new UserError(
			`Target file '${toPath}' not found. Create a agents.yaml first (e.g. \`agents init\`), then run migrate.`,
		);
	}

	const result = await migrateConfig({ fromPath, toPath });

	await writeFile(toPath, result.yaml, "utf8");

	const addedParts: string[] = [];
	for (const [group, count] of Object.entries(result.added)) {
		addedParts.push(`${count} ${group}`);
	}

	const skippedParts: string[] = [];
	for (const [group, count] of Object.entries(result.skipped)) {
		skippedParts.push(`${count} ${group}`);
	}

	if (addedParts.length) {
		log.success(`Migrated ${addedParts.join(", ")} into ${toPath}.`);
	} else {
		log.info("No new resources to migrate (all already exist in target).");
	}

	if (skippedParts.length) {
		log.info(`Skipped (already exist): ${skippedParts.join(", ")}.`);
	}
}

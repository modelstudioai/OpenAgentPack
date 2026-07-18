import { resolve } from "node:path";
import { resolveProjectConfig, UserError, validateProjectConfig } from "@openagentpack/sdk";
import { ensureCredentials } from "../credentials.ts";
import { log } from "../logger.ts";

export async function validateCommand(options: { file: string }) {
	ensureCredentials();
	const configPath = resolve(options.file);
	log.info(`Validating ${configPath}...`);
	const { config } = await resolveProjectConfig(options.file);
	const diagnostics = validateProjectConfig(config);

	for (const d of diagnostics) {
		const line = d.resource ? `${d.message} (${d.resource.type}.${d.resource.name})` : d.message;
		if (d.severity === "error") log.error(line);
		else if (d.severity === "warning") log.warn(line);
		else log.info(line);
	}

	const errorCount = diagnostics.filter((d) => d.severity === "error").length;
	if (errorCount > 0) {
		throw new UserError(`Validation failed with ${errorCount} error(s).`);
	}
	log.success("Configuration is valid.");
}

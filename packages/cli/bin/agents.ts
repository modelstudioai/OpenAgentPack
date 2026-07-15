#!/usr/bin/env node
import { UserError } from "@openagentpack/sdk";
import { configureLogger, log } from "../src/logger.ts";
import { program } from "../src/program.ts";

if (process.env.AGENTS_DEBUG) {
	configureLogger({ verbose: 2, color: true });
}

program.parseAsync().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	log.error(message);

	if (!(err instanceof UserError)) {
		if (process.env.AGENTS_DEBUG) {
			console.error(err);
		} else {
			console.error("  Run with AGENTS_DEBUG=1 for full details.");
		}
	}

	process.exit(1);
});

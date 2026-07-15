import * as p from "@clack/prompts";
import {
	type DestroyResourceResult,
	destroyPlannedProjectResources,
	planDestroyProjectContext,
} from "@openagentpack/sdk";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { formatResourceLabel } from "../utils/address-utils.ts";

export async function destroyCommand(options: { file: string; yes?: boolean; cascade?: boolean }) {
	const ctx = await buildCliRuntime(options.file);
	const planned = planDestroyProjectContext(ctx);
	const resources = planned.resources;

	if (resources.length === 0) {
		log.info("No resources in state. Nothing to destroy.");
		return;
	}

	console.log(chalk.red(`\nDestroy ${resources.length} resource(s):\n`));
	for (const r of resources) {
		console.log(chalk.red(`  - ${formatResourceLabel(r.address)} [${r.remote_id}]`));
	}

	if (!options.yes) {
		const shouldDestroy = await p.confirm({
			message: "Are you sure you want to destroy ALL resources?",
			output: process.stderr,
		});
		if (p.isCancel(shouldDestroy) || !shouldDestroy) {
			p.cancel("Destroy cancelled.", { output: process.stderr });
			return;
		}
	}

	let activeSpinner: ReturnType<typeof p.spinner> | undefined;

	const result = await destroyPlannedProjectResources(planned, {
		cascade: options.cascade,
		onResourceStart: (resource) => {
			activeSpinner = p.spinner({ output: process.stderr });
			activeSpinner.start(`Destroying ${formatResourceLabel(resource.address)}`);
		},
		onCascadeRequired: async (blocked) => {
			activeSpinner?.stop(
				chalk.yellow(`⚠ ${formatResourceLabel(blocked.resource.address)} — ${blocked.error ?? "cascade required"}`),
			);
			activeSpinner = undefined;

			if (options.yes) {
				log.info(`Hint: ${chalk.bold(`agents destroy -f ${options.file} --cascade`)}`);
				return false;
			}

			const cascadeConfirm = await p.confirm({
				message: "Delete associated sessions and retry?",
				output: process.stderr,
			});
			if (p.isCancel(cascadeConfirm) || !cascadeConfirm) return false;

			activeSpinner = p.spinner({ output: process.stderr });
			activeSpinner.start(`Destroying ${formatResourceLabel(blocked.resource.address)} with cascade`);
			return true;
		},
		onResourceResult: (item) => {
			stopResourceSpinner(activeSpinner, item);
			activeSpinner = undefined;
		},
	});

	const summary =
		result.destroyed === result.resources.length
			? chalk.green(`Destroy complete. ${result.destroyed}/${result.resources.length} resources removed.`)
			: chalk.yellow(`Destroy complete. ${result.destroyed}/${result.resources.length} resources removed.`);
	p.outro(summary, { output: process.stderr });
}

function stopResourceSpinner(spinner: ReturnType<typeof p.spinner> | undefined, result: DestroyResourceResult): void {
	const label = formatResourceLabel(result.resource.address);
	if (!spinner) {
		if (result.reason === "provider_missing") {
			log.warn(result.error ?? `No provider for '${result.resource.address.provider}', skipping ${label}`);
		}
		return;
	}

	if (result.status === "success") {
		if (result.reason === "already_gone") {
			spinner.stop(chalk.yellow(`⊘ ${label} — already deleted remotely, cleaned up state`));
		} else if (result.cascaded) {
			spinner.stop(chalk.green(`✓ ${label} — destroyed (cascaded)`));
		} else {
			spinner.stop(chalk.green(`✓ ${label} — destroyed`));
		}
		return;
	}

	if (result.reason === "provider_missing") {
		spinner.stop(
			chalk.yellow(result.error ?? `No provider for '${result.resource.address.provider}', skipping ${label}`),
		);
		return;
	}

	if (result.status === "blocked") {
		spinner.stop(chalk.yellow(`⚠ ${label} — ${result.error ?? "blocked"}`));
		return;
	}

	spinner.stop(chalk.red(`✗ ${label} — ${result.error ?? "unknown error"}`));
}

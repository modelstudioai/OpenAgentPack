import * as p from "@clack/prompts";
import { assertLegacyYamlNotShadowed } from "@openagentpack/project-workspace";
import {
	type DestroyDefaultMemoryStoreResult,
	type DestroyResourceResult,
	destroyPlannedProjectResources,
	planDestroyProjectContext,
} from "@openagentpack/sdk";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { formatResourceLabel } from "../utils/address-utils.ts";

export async function destroyCommand(options: { file: string; yes?: boolean; cascade?: boolean }) {
	await assertLegacyYamlNotShadowed(options.file);
	const ctx = await buildCliRuntime(options.file);
	const planned = planDestroyProjectContext(ctx);
	const resources = planned.resources;

	const pendingDefaultMemoryStores = planned.defaultMemoryStores.filter((store) => store.memoryStoreId);
	if (resources.length === 0 && pendingDefaultMemoryStores.length === 0) {
		log.info("No resources in state. Nothing to destroy.");
		return;
	}

	console.log(chalk.red(`\nDestroy ${resources.length} resource(s):\n`));
	for (const r of resources) {
		console.log(chalk.red(`  - ${formatResourceLabel(r.address)} [${r.remote_id}]`));
	}
	for (const store of planned.defaultMemoryStores) {
		const policy = store.deleteOnDestroy ? chalk.red.bold("permanently delete") : chalk.green("retain");
		console.log(`  - default_memory_store.${store.agentName} [${policy}]`);
	}
	if (planned.defaultMemoryStores.some((store) => store.deleteOnDestroy)) {
		console.log(chalk.red.bold("\nDefault Memory Store content and all version history will be permanently deleted."));
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
	for (const store of result.defaultMemoryStoreResults) renderDefaultMemoryStoreResult(store);

	const summary = !result.partial
		? chalk.green(`Destroy complete. ${result.destroyed}/${result.resources.length} resources removed.`)
		: chalk.yellow(`Destroy partial. ${result.destroyed}/${result.resources.length} resources removed.`);
	p.outro(summary, { output: process.stderr });
}

function renderDefaultMemoryStoreResult(result: DestroyDefaultMemoryStoreResult): void {
	const label = `default_memory_store.${result.agentName}`;
	if (result.status === "retained") log.success(`${label} — retained`);
	else if (result.status === "deleted") log.success(`${label} — permanently deleted`);
	else if (result.status === "already_gone") log.warn(`${label} — already absent`);
	else log.error(`${label} — delete failed: ${result.error ?? "unknown error"}`);
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
		if (result.reason === "reference_removed") {
			spinner.stop(chalk.green(`✓ ${label} — local reference removed (remote left intact)`));
		} else if (result.reason === "already_gone") {
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

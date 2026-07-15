import { importResource, parseStateAddress, UserError } from "@openagentpack/sdk";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { printTableFooter, printTableHeader, printTableTitle } from "../render-table.ts";

export async function stateListCommand(options: { file: string }) {
	const ctx = await buildCliRuntime(options.file);
	const resources = ctx.state.listResources();

	if (resources.length === 0) {
		log.info("No resources tracked in state.");
		return;
	}

	printTableTitle("Managed resources", resources.length);
	printTableHeader(["TYPE            NAME                PROVIDER   REMOTE ID"], 70);

	for (const r of resources) {
		const type = r.address.type.padEnd(14);
		const name = r.address.name.padEnd(20);
		const provider = r.address.provider.padEnd(10);
		const id = (r.remote_id ?? "(local)").slice(0, 30);
		console.log(`  ${type}  ${name}${provider} ${chalk.dim(id)}`);
	}
	printTableFooter();
}

export async function stateShowCommand(address: string, options: { file: string }) {
	const ctx = await buildCliRuntime(options.file);
	const parsed = parseStateAddress(address, { requireProvider: false });
	const found = ctx.state.findResource(parsed);
	if (!found) throw new UserError(`Resource not found: ${address}`);
	console.log(JSON.stringify(found, null, 2));
}

export async function stateRemoveCommand(address: string, options: { file: string }) {
	const ctx = await buildCliRuntime(options.file);
	const parsed = parseStateAddress(address, { requireProvider: false });
	const found = ctx.state.findResource(parsed);
	if (!found) throw new UserError(`Resource not found: ${address}`);
	ctx.state.removeResource(found.address);
	await ctx.state.save();
	log.success(`Removed ${address} from state (remote resource not deleted).`);
}

export async function stateImportCommand(
	address: string,
	remoteId: string,
	options: { file: string; resourceVersion?: number },
) {
	const ctx = await buildCliRuntime(options.file);
	const parsed = parseStateAddress(address, { requireProvider: true });
	await importResource(ctx, parsed, remoteId, { resourceVersion: options.resourceVersion });
	log.success(`Imported ${address} (remote_id: ${remoteId}) into state.`);
}

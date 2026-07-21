import {
	getDeploymentDetailsForContext,
	getDeploymentRuntimeProviderForContext,
	listDeploymentsForContext,
	listRemoteDeploymentsForContext,
	pauseDeploymentForContext,
	runDeploymentForContext,
	UserError,
} from "@openagentpack/sdk";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { columnWidth, printTableFooter, printTableHeader, printTableRow, printTableTitle } from "../render-table.ts";
import { fetchAllPages } from "../utils/pagination.ts";

interface DeploymentListOpts {
	file: string;
	provider?: string;
	remote?: boolean;
	status?: "active" | "paused";
	includeArchived?: boolean;
	agentId?: string;
	limit?: number;
	all?: boolean;
}

export async function deploymentListCommand(options: DeploymentListOpts) {
	const ctx = await buildCliRuntime(options.file);
	if (options.remote) {
		if (!options.provider) throw new UserError("Remote deployment listing requires --provider.");
		if (options.provider === "claude" && options.status && options.includeArchived) {
			throw new UserError("Claude remote deployment listing cannot combine --status with --include-archived.");
		}
		const { items, hasMore } = await fetchAllPages(async (page) => {
			const result = await listRemoteDeploymentsForContext(ctx, options.provider!, {
				status: options.status,
				include_archived: options.includeArchived,
				agent_id: options.agentId,
				limit: options.limit,
				page,
			});
			return { items: result.deployments, hasMore: result.has_more, nextPage: result.next_page };
		}, options.all);
		if (items.length === 0) {
			log.info("No remote deployments found.");
			return;
		}
		printTableTitle("Remote Deployments", items.length);
		printTableHeader(["Name".padEnd(24), "ID".padEnd(28), "Status".padEnd(10), "Schedule"], 82);
		for (const item of items) {
			const raw = item.attributes ?? {};
			const name = String(raw.name ?? "")
				.slice(0, 22)
				.padEnd(24);
			const id = String(item.id ?? "")
				.slice(0, 26)
				.padEnd(28);
			const schedule = item.schedule?.expression ?? "manual";
			printTableRow([chalk.bold(name), id, item.status.padEnd(10), schedule]);
		}
		printTableFooter();
		if (hasMore) log.info("More deployments available. Use --all to fetch all.");
		return;
	}
	const rows = listDeploymentsForContext(ctx, options.provider);

	if (rows.length === 0) {
		log.info("No deployments in state. Run `agents apply` first.");
		return;
	}

	const nameWidth = columnWidth(rows.map((r) => r.name.length));

	printTableTitle("Deployments", rows.length);
	printTableHeader(
		["Name".padEnd(nameWidth), "Provider".padEnd(10), "Remote ID".padEnd(28), "Schedule".padEnd(18), "Agent"],
		nameWidth + 70,
	);

	for (const r of rows) {
		const nameCell = chalk.bold(r.name.padEnd(nameWidth));
		const provCell = chalk.cyan(r.provider.padEnd(10));
		const idCell = r.remoteId ? r.remoteId.slice(0, 26).padEnd(28) : chalk.dim("(emulated)".padEnd(28));
		const schedCell = r.scheduleExpression.padEnd(18);
		printTableRow([nameCell, provCell, idCell, schedCell, r.agent]);
	}
	printTableFooter();
}

interface DeploymentPauseOpts {
	file: string;
	provider?: string;
}

export async function deploymentPauseCommand(name: string, options: DeploymentPauseOpts, paused = true) {
	const ctx = await buildCliRuntime(options.file);
	const info = await pauseDeploymentForContext(ctx, name, paused, options.provider);
	log.success(`Deployment '${name}' ${paused ? "paused" : "unpaused"}.`);
	console.log(`  Status: ${info.status}`);
}

interface DeploymentGetOpts {
	file: string;
	provider?: string;
}

export async function deploymentGetCommand(name: string, options: DeploymentGetOpts) {
	const ctx = await buildCliRuntime(options.file);
	const { bindings, provider, info } = await getDeploymentDetailsForContext(ctx, name, undefined, options.provider);

	console.log(`  Name:        ${chalk.bold(name)}`);
	console.log(`  Provider:    ${provider}`);
	console.log(`  Remote ID:   ${info.id ?? chalk.dim("(emulated / local)")}`);
	console.log(`  Status:      ${info.status}`);
	if (info.paused_reason) {
		const pr = info.paused_reason;
		const detail = pr.error?.type ? `${pr.type} (${pr.error.type})` : pr.type;
		console.log(`  Paused:      ${detail}`);
	}
	if (info.schedule) {
		const tz = info.schedule.timezone ? ` (${info.schedule.timezone})` : "";
		console.log(`  Schedule:    ${info.schedule.expression}${tz}`);
	}
	console.log(`  Agent:       ${bindings.agentId}`);
	console.log(`  Environment: ${bindings.environmentId}`);
	if (bindings.vaultIds.length) console.log(`  Vaults:      ${bindings.vaultIds.join(", ")}`);
	if (bindings.memoryStoreIds.length) console.log(`  Memory:      ${bindings.memoryStoreIds.join(", ")}`);
}

interface DeploymentRunOpts {
	file: string;
	provider?: string;
}

export async function deploymentRunCommand(name: string, options: DeploymentRunOpts) {
	const ctx = await buildCliRuntime(options.file);
	const provider = getDeploymentRuntimeProviderForContext(ctx, name, options.provider);
	log.info(`Running deployment '${name}' on ${provider}...`);
	const { result } = await runDeploymentForContext(ctx, name, undefined, options.provider);

	if (result.error) {
		if (result.run_id) console.log(`  Run ID:     ${result.run_id}`);
		throw new UserError(`Deployment run failed: ${result.error.type} - ${result.error.message}`);
	}

	log.success(`Deployment '${name}' run started.`);
	if (result.run_id) console.log(`  Run ID:     ${chalk.bold(result.run_id)}`);
	console.log(`  Session ID: ${result.session_id ? chalk.bold(result.session_id) : chalk.dim("(pending)")}`);
}

import { UserError } from "@openagentpack/sdk";
import chalk from "chalk";
import { assertProviderConfigured, buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { planProjectWithRefresh } from "../plan-workflow.ts";
import { diagnosticsHaveErrors, renderDiagnostics } from "../render-diagnostics.ts";
import { writeJson } from "../runtime.ts";
import { formatResourceAddress, formatResourceLabel } from "../utils/address-utils.ts";

export async function planCommand(options: {
	file: string;
	provider?: string;
	json?: boolean;
	refresh?: boolean;
	refreshOnly?: boolean;
}) {
	const ctx = await buildCliRuntime(options.file);
	assertProviderConfigured(ctx, options.provider);

	const { plan } = await planProjectWithRefresh(ctx, {
		provider: options.provider,
		refresh: options.refresh,
		quiet: !!options.json,
	});

	// Output
	if (options.json) {
		writeJson(plan);
		if (plan.diagnostics.some((d) => d.severity === "error")) {
			throw new UserError("Plan contains errors.");
		}
		return;
	}

	// Display diagnostics
	renderDiagnostics(plan.diagnostics);
	if (diagnosticsHaveErrors(plan.diagnostics)) {
		throw new UserError("Plan contains errors.");
	}

	// Display plan summary
	const creates = plan.actions.filter((a) => a.action === "create");
	const updates = plan.actions.filter((a) => a.action === "update");
	const deletes = plan.actions.filter((a) => a.action === "delete");

	// Resources whose remote content the provider can't read back (existence-only
	// or unsupported drift). They yield no action, but dropping them silently lets
	// the summary imply "in sync" when it really means "couldn't be checked".
	const driftByAddress = new Map<string, string | undefined>();
	for (const r of ctx.state.listResources()) {
		driftByAddress.set(formatResourceAddress(r.address), r.drift_status);
	}
	const unverified = plan.actions.filter(
		(a) => a.action === "no-op" && driftByAddress.get(formatResourceAddress(a.address)) === "unchecked",
	);

	const hasChanges = creates.length > 0 || updates.length > 0 || deletes.length > 0;

	if (!hasChanges && unverified.length === 0) {
		log.success("No changes. Infrastructure is up-to-date.");
		return;
	}

	if (hasChanges) {
		console.log("\nPlanned actions:\n");

		for (const a of creates) {
			console.log(chalk.green(`  + ${formatResourceLabel(a.address)}`));
		}
		for (const a of updates) {
			console.log(chalk.yellow(`  ~ ${formatResourceLabel(a.address)}`));
			console.log(chalk.yellow(`    ${a.reason}`));
		}
		for (const a of deletes) {
			console.log(chalk.red(`  - ${formatResourceLabel(a.address)}`));
		}
	} else {
		console.log("\nNo changes to apply.");
	}

	if (unverified.length > 0) {
		console.log(chalk.blue("\nUnverified (provider can't compare content):"));
		for (const a of unverified) {
			console.log(
				chalk.blue(`  ! ${formatResourceLabel(a.address)}`) + chalk.dim(" — exists remotely; drift undetectable"),
			);
		}
	}

	if (hasChanges) {
		console.log(
			`\nPlan: ${chalk.green(`${creates.length} to create`)}, ${chalk.yellow(`${updates.length} to update`)}, ${chalk.red(`${deletes.length} to destroy`)}.`,
		);
	}
	if (options.refreshOnly) {
		console.log(chalk.blue("Refresh-only mode: no remote mutations will be performed."));
	}
}

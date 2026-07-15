import * as p from "@clack/prompts";
import { decideDestructive, executePlannedProject, type PlannedAction, UserError } from "@openagentpack/sdk";
import chalk from "chalk";
import { assertProviderConfigured, buildCliRuntime } from "../config-loader.ts";
import { log } from "../logger.ts";
import { planProjectWithRefresh } from "../plan-workflow.ts";
import { diagnosticsHaveErrors, renderDiagnostics } from "../render-diagnostics.ts";
import { renderRuntimeFeedback } from "../render-feedback.ts";
import { formatResourceAddress, formatResourceLabel } from "../utils/address-utils.ts";

type ApplyPromptKind = "combined_drift" | "remote_drift" | "local_change" | "planned_change";

function classifyApplyPrompt(actions: PlannedAction[]): ApplyPromptKind {
	if (actions.some((a) => a.driftKind === "both")) return "combined_drift";
	if (actions.some((a) => a.driftKind === "remote")) return "remote_drift";
	if (actions.some((a) => a.driftKind === "local")) return "local_change";
	return "planned_change";
}

// Confirm callback for the SDK destructive policy (policy="prompt").
async function confirmDestroy(deletes: PlannedAction[]): Promise<boolean> {
	log.plain(chalk.red.bold(`\nResources will be destroyed.`));
	log.plain(chalk.red(`Applying will delete ${deletes.length} resource(s) listed above.`));
	const shouldApply = await p.confirm({
		message: `Apply and destroy ${deletes.length} resource(s)?`,
		output: process.stderr,
	});
	return !p.isCancel(shouldApply) && shouldApply;
}

// Non-destructive overwrite confirmation (drift / planned changes). Host UX only;
// destructive deletes are gated separately by the SDK destructive policy.
async function confirmDrift(actions: PlannedAction[], file: string): Promise<boolean> {
	const kind = classifyApplyPrompt(actions);

	if (kind === "combined_drift" || kind === "remote_drift") {
		const hasCombinedDrift = kind === "combined_drift";
		log.plain();
		if (hasCombinedDrift) {
			log.plain(chalk.yellow("Both local YAML and remote resource changed since the last apply."));
			log.plain(
				chalk.yellow(
					"Applying will update the remote resource to match the current YAML and may overwrite remote-only changes.",
				),
			);
		} else {
			log.plain(chalk.yellow("Remote-only changes were detected."));
			log.plain(chalk.yellow("Applying will overwrite the remote resource with the current YAML."));
		}
		const driftActions = actions.filter((a) => a.driftKind === "remote" || a.driftKind === "both");
		const driftAction = driftActions.length === 1 ? driftActions[0] : undefined;
		const inspectAddress = driftAction ? formatResourceAddress(driftAction.address) : "<address>";
		log.plain(
			chalk.gray(
				`OpenAgentPack will not pull remote changes into YAML automatically. To keep them, cancel and inspect with: agents state show ${inspectAddress} -f ${file}`,
			),
		);

		const choice = await p.select({
			message: hasCombinedDrift ? "How do you want to handle this conflict?" : "How do you want to handle this drift?",
			output: process.stderr,
			options: [
				{
					value: "apply",
					label: hasCombinedDrift ? "Apply YAML to remote" : "Overwrite remote with YAML",
					hint: hasCombinedDrift ? "YAML wins; remote-only changes may be overwritten" : "YAML wins",
				},
				{
					value: "cancel",
					label: "Cancel and keep remote unchanged",
					hint: "Update YAML manually if you want to keep remote changes",
				},
			],
		});
		return !p.isCancel(choice) && choice === "apply";
	}

	const message =
		kind === "local_change"
			? "Local YAML changes were detected. Apply YAML to remote?"
			: "Apply planned YAML changes to remote?";
	const shouldApply = await p.confirm({ message, output: process.stderr });
	return !p.isCancel(shouldApply) && shouldApply;
}

export async function applyCommand(options: {
	file: string;
	yes?: boolean;
	provider?: string;
	refresh?: boolean;
	refreshOnly?: boolean;
	concurrency?: number;
}) {
	const ctx = await buildCliRuntime(options.file);
	assertProviderConfigured(ctx, options.provider);

	const planned = await planProjectWithRefresh(ctx, {
		provider: options.provider,
		refresh: options.refresh,
	});
	const plan = planned.plan;

	renderDiagnostics(plan.diagnostics);
	if (diagnosticsHaveErrors(plan.diagnostics)) {
		throw new UserError("Cannot apply: resolve the errors above first.");
	}

	const actionable = plan.actions.filter((a) => a.action !== "no-op");
	if (actionable.length === 0) {
		log.success("No changes. Infrastructure is up-to-date.");
		return;
	}

	const creates = actionable.filter((a) => a.action === "create");
	const updates = actionable.filter((a) => a.action === "update");
	const deletes = planned.destructiveActions;

	console.log(
		`\n${chalk.green(`${creates.length} to create`)}, ${chalk.yellow(`${updates.length} to update`)}, ${chalk.red(`${deletes.length} to destroy`)}\n`,
	);

	for (const a of actionable) {
		const icon = a.action === "create" ? "+" : a.action === "update" ? "~" : "-";
		const color = a.action === "create" ? chalk.green : a.action === "update" ? chalk.yellow : chalk.red;
		console.log(color(`  ${icon} ${formatResourceLabel(a.address)}`));
		if (a.action === "update") {
			console.log(color(`    ${a.reason}`));
		}
	}

	if (options.refreshOnly) {
		log.info("Refresh-only mode: no remote mutations will be performed.");
		return;
	}

	if (deletes.length > 0) {
		console.log(chalk.red.bold(`\n  ⚠ Resources to be DESTROYED:`));
		for (const a of deletes) {
			console.log(chalk.red(`    - ${formatResourceLabel(a.address)}`));
		}
		console.log();
	}

	const destructiveDecision = await decideDestructive(deletes, {
		policy: options.yes ? "force" : "prompt",
		confirm: confirmDestroy,
	});
	if (destructiveDecision !== "proceed") {
		p.cancel("Apply cancelled. No remote resources were changed.", {
			output: process.stderr,
		});
		return;
	}

	if (!options.yes && deletes.length === 0) {
		const shouldApply = await confirmDrift(actionable, options.file);
		if (!shouldApply) {
			p.cancel("Apply cancelled. No remote resources were changed.", {
				output: process.stderr,
			});
			return;
		}
	}

	const s = p.spinner({ output: process.stderr });
	s.start("Applying changes...");

	const result = await executePlannedProject(planned, {
		onFeedback: renderRuntimeFeedback,
		policy: "force",
		concurrency: options.concurrency,
	});

	const succeeded = result.results.filter((r) => r.status === "success").length;
	const failed = result.results.filter((r) => r.status === "failed").length;
	const skipped = result.results.filter((r) => r.status === "skipped").length;

	s.stop("Apply finished.");

	if (failed > 0) {
		p.log.warning(`${succeeded} succeeded, ${failed} failed, ${skipped} skipped.`, { output: process.stderr });
		throw new UserError("Apply failed.");
	} else {
		p.log.success(`Apply complete! ${succeeded} actions executed successfully.`, { output: process.stderr });
	}
}

import { listProviderModelsForContext } from "@openagentpack/sdk";
import chalk from "chalk";
import { buildCliRuntime } from "../config-loader.ts";
import { columnWidth, printTableHeader, printTableRow } from "../render-table.ts";

export async function modelsListCommand(options: { file: string; provider?: string; json?: boolean }) {
	const ctx = await buildCliRuntime(options.file);
	const listings = await listProviderModelsForContext(ctx.providers, options.provider);
	for (const listing of listings) {
		const name = listing.provider;
		if (!listing.supportsDynamicListing) {
			if (options.json) {
				process.stdout.write(
					`${JSON.stringify({ provider: name, supportsDynamicListing: false, models: [] }, null, 2)}\n`,
				);
			} else {
				console.log(chalk.yellow(`\n  Provider '${name}' does not support dynamic model listing.`));
				if (name === "claude") {
					console.log(chalk.dim(`  Claude models are specified directly (e.g. claude-sonnet-4-6, claude-opus-4-6).`));
					console.log(chalk.dim(`  See: https://docs.anthropic.com/en/docs/about-claude/models\n`));
				} else if (name === "bailian") {
					console.log(chalk.dim(`  Bailian models are specified directly (e.g. qwen-max, qwen-plus).`));
					console.log(chalk.dim(`  See: https://help.aliyun.com/zh/model-studio/getting-started/models\n`));
				} else if (name === "ark") {
					console.log(chalk.dim(`  Ark models are specified directly (e.g. doubao-seed-2-1-pro-260628).`));
					console.log(chalk.dim(`  See: https://www.volcengine.com/docs/82379\n`));
				} else {
					console.log(chalk.dim(`  Refer to the provider's documentation for available model identifiers.\n`));
				}
			}
			continue;
		}

		const models = listing.models;

		if (options.json) {
			process.stdout.write(`${JSON.stringify({ provider: name, models }, null, 2)}\n`);
			continue;
		}

		console.log(chalk.bold(`\nAvailable models (${name}):\n`));

		const colId = columnWidth(
			models.map((m) => m.id.length),
			4,
		);
		const colName = columnWidth(
			models.map((m) => m.display_name.length),
			12,
		);
		const colPrice = 7;
		const colEfforts = columnWidth(
			models.map((m) => formatEfforts(m.efforts).length),
			7,
		);

		printTableHeader(
			["ID".padEnd(colId), "Name".padEnd(colName), "Price".padEnd(colPrice), "Efforts".padEnd(colEfforts), "Default"],
			colId + colName + colPrice + colEfforts + 7 + 4,
		);

		for (const m of models) {
			const id = m.id.padEnd(colId);
			const displayName = m.display_name.padEnd(colName);
			const price = formatPrice(m.price_factor).padEnd(colPrice);
			const efforts = formatEfforts(m.efforts).padEnd(colEfforts);
			const defaultEffort = m.default_effort ?? "—";
			const isNew = m.is_new ? chalk.green(" NEW") : "";

			printTableRow([id, displayName, price, efforts, `${defaultEffort}${isNew}`]);
		}

		console.log(chalk.dim(`\n  Use ${chalk.reset("model: <ID>")} in your agents.yaml agent configuration.`));
		console.log(chalk.dim(`  Use ${chalk.reset("model: { id: <ID>, effort: <EFFORT> }")} for effort control.\n`));
	}
}

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

function formatEfforts(efforts?: string[]): string {
	if (!efforts?.length) return "—";
	return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)).join(", ");
}

function formatPrice(factor?: number): string {
	if (factor === undefined) return "—";
	if (factor === 0) return "free";
	return `×${factor}`;
}

import chalk from "chalk";

const DEFAULT_INDENT = "  ";

export function columnWidth(lengths: number[], min = 4, padding = 2): number {
	if (lengths.length === 0) return min + padding;
	return Math.max(min, ...lengths) + padding;
}

export function printTableTitle(title: string, count: number): void {
	console.log(`\n${chalk.bold(title)} (${count}):\n`);
}

export function printTableHeader(headers: string[], separatorWidth: number, indent = DEFAULT_INDENT): void {
	console.log(chalk.gray(`${indent}${headers.join(" ")}`));
	console.log(chalk.gray(`${indent}${"─".repeat(separatorWidth)}`));
}

export function printTableRow(cells: string[], indent = DEFAULT_INDENT): void {
	console.log(`${indent}${cells.join(" ")}`);
}

export function printTableFooter(): void {
	console.log();
}

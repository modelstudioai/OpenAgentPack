import type { Diagnostic } from "@openagentpack/sdk";
import chalk from "chalk";

/** Render plan/apply diagnostics to stdout (planning UX). validate prints to stderr separately. */
export function renderDiagnostics(diagnostics: Diagnostic[]): void {
	if (diagnostics.length === 0) return;
	console.log("\nDiagnostics:");
	for (const d of diagnostics) {
		const icon = d.severity === "error" ? "✗" : d.severity === "warning" ? "⚠" : "ℹ";
		const color = d.severity === "error" ? chalk.red : d.severity === "warning" ? chalk.yellow : chalk.blue;
		console.log(color(`  ${icon} ${d.code}`));
		if (d.resource) {
			console.log(`    Resource: ${d.resource.type}.${d.resource.name} (${d.resource.provider})`);
		}
		console.log(`    ${d.message}`);
	}
	console.log();
}

export function diagnosticsHaveErrors(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((d) => d.severity === "error");
}

import type { Diagnostic, DiagnosticSeverity } from "../types/plan.ts";
import type { ResourceAddress } from "../types/state.ts";

export class DiagnosticCollector {
	private items: Diagnostic[] = [];

	error(code: string, message: string, resource?: ResourceAddress): void {
		this.items.push({ severity: "error", code, message, resource });
	}

	warning(code: string, message: string, resource?: ResourceAddress): void {
		this.items.push({ severity: "warning", code, message, resource });
	}

	info(code: string, message: string, resource?: ResourceAddress): void {
		this.items.push({ severity: "info", code, message, resource });
	}

	hasErrors(): boolean {
		return this.items.some((d) => d.severity === "error");
	}

	getAll(): Diagnostic[] {
		return [...this.items];
	}

	format(): string {
		if (this.items.length === 0) return "";
		const lines: string[] = [];
		for (const d of this.items) {
			const icon = severityIcon(d.severity);
			const addr = d.resource ? ` ${d.resource.type}.${d.resource.name} (${d.resource.provider})` : "";
			lines.push(`${icon} ${d.code}`);
			if (addr) lines.push(`  Resource:${addr}`);
			lines.push(`  ${d.message}`);
			lines.push("");
		}
		return lines.join("\n");
	}
}

function severityIcon(s: DiagnosticSeverity): string {
	switch (s) {
		case "error":
			return "✗";
		case "warning":
			return "⚠";
		case "info":
			return "ℹ";
	}
}

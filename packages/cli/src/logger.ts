import chalk from "chalk";

// Strict-Unix stream separation: this is the diagnostic channel. Everything here
// goes to stderr so stdout stays a clean data channel (tables, JSON) that callers
// can pipe. Primary command output (results/reports) is written to stdout elsewhere.

type LogLevel = "error" | "warn" | "success" | "info" | "debug";

const PRIORITY: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	success: 2,
	info: 3,
	debug: 4,
};

let maxLevel: LogLevel = "info";

export function configureLogger(opts: { verbose?: number; quiet?: boolean; color?: boolean }): void {
	if (opts.quiet) {
		maxLevel = "error";
	} else if ((opts.verbose ?? 0) >= 2) {
		maxLevel = "debug";
	} else if ((opts.verbose ?? 0) >= 1) {
		maxLevel = "success";
	} else {
		maxLevel = "info";
	}

	if (opts.color === false || process.env.NO_COLOR) {
		chalk.level = 0;
	}
}

function shouldEmit(level: LogLevel): boolean {
	return PRIORITY[level] <= PRIORITY[maxLevel];
}

function emit(level: LogLevel, icon: string, msg: string): void {
	if (!shouldEmit(level)) return;
	console.error(`${icon} ${msg}`);
}

export const log = {
	debug(msg: string) {
		emit("debug", chalk.dim("•"), msg);
	},
	info(msg: string) {
		emit("info", chalk.blue("ℹ"), msg);
	},
	success(msg: string) {
		emit("success", chalk.green("✓"), msg);
	},
	warn(msg: string) {
		emit("warn", chalk.yellow("⚠"), msg);
	},
	error(msg: string) {
		emit("error", chalk.red("✗"), msg);
	},
	adopt(msg: string) {
		emit("info", chalk.cyan("⟳"), msg);
	},
	gone(msg: string) {
		emit("warn", chalk.yellow("⊘"), msg);
	},
	plain(msg = "") {
		if (shouldEmit("info")) console.error(msg);
	},
};

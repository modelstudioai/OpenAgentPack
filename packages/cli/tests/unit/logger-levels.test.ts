import { afterEach, beforeEach, expect, test } from "bun:test";
import chalk from "chalk";
import { configureLogger, log } from "../../src/logger.ts";

const originalLevel = chalk.level;
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
	delete process.env.NO_COLOR;
	chalk.level = 1;
});

afterEach(() => {
	if (originalNoColor === undefined) {
		delete process.env.NO_COLOR;
	} else {
		process.env.NO_COLOR = originalNoColor;
	}
	chalk.level = originalLevel;
});

function captureStderr(fn: () => void): string {
	const original = console.error;
	const chunks: string[] = [];
	console.error = (msg: string) => {
		chunks.push(msg);
	};
	try {
		fn();
	} finally {
		console.error = original;
	}
	return chunks.join("\n");
}

test("default level emits info, success, warn, error", () => {
	configureLogger({ verbose: 0, quiet: false, color: false });

	const output = captureStderr(() => {
		log.info("info-msg");
		log.success("success-msg");
		log.warn("warn-msg");
		log.error("error-msg");
	});

	expect(output).toContain("info-msg");
	expect(output).toContain("success-msg");
	expect(output).toContain("warn-msg");
	expect(output).toContain("error-msg");
});

test("quiet suppresses everything except error", () => {
	configureLogger({ verbose: 0, quiet: true, color: false });

	const output = captureStderr(() => {
		log.info("info-msg");
		log.success("success-msg");
		log.warn("warn-msg");
		log.error("error-msg");
	});

	expect(output).not.toContain("info-msg");
	expect(output).not.toContain("success-msg");
	expect(output).not.toContain("warn-msg");
	expect(output).toContain("error-msg");
});

test("verbose level 2 emits debug messages", () => {
	configureLogger({ verbose: 2, quiet: false, color: false });

	const output = captureStderr(() => {
		log.debug("debug-msg");
		log.info("info-msg");
	});

	expect(output).toContain("debug-msg");
	expect(output).toContain("info-msg");
});

test("default level suppresses debug", () => {
	configureLogger({ verbose: 0, quiet: false, color: false });

	const output = captureStderr(() => {
		log.debug("debug-msg");
	});

	expect(output).not.toContain("debug-msg");
});

test("no-color disables chalk colors", () => {
	configureLogger({ verbose: 0, quiet: false, color: false });

	expect(chalk.level).toBe(0);
});

test("color enabled keeps chalk active", () => {
	configureLogger({ verbose: 0, quiet: false, color: true });

	expect(chalk.level).toBe(1);
});

test("NO_COLOR overrides the default color setting", () => {
	process.env.NO_COLOR = "1";
	configureLogger({ verbose: 0, quiet: false, color: true });

	expect(chalk.level).toBe(0);
});

test("plain is suppressed under quiet", () => {
	configureLogger({ verbose: 0, quiet: true, color: false });

	const output = captureStderr(() => {
		log.plain("plain-msg");
	});

	expect(output).not.toContain("plain-msg");
});

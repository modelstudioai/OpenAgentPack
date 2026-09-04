import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface AuditResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	errorCode?: string;
	signal?: string;
}

const retryDelaysMs = [2_000, 5_000] as const;
const root = resolve(import.meta.dirname, "..");

export function isTransientAuditFailure(result: AuditResult): boolean {
	if (result.exitCode === 0) return false;

	// Only retry a standalone transport error, optionally preceded by Bun's banner.
	// A vulnerability report or any unknown error must remain an immediate failure.
	const diagnostics = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !/^bun audit(?: v\d+\.\d+\.\d+(?:-[\w.-]+)?(?: \([a-f0-9]+\))?)?$/.test(line));
	const transportError =
		diagnostics.length === 1 &&
		/^(?:ConnectionClosed|ConnectionReset|ConnectionRefused|Timeout): audit request failed$/.test(diagnostics[0]);
	if (result.errorCode === "ETIMEDOUT") return diagnostics.length === 0 || transportError;
	if (result.errorCode || result.signal) return false;
	return transportError;
}

function executeAudit(): AuditResult {
	const result = spawnSync(process.execPath, ["audit"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 45_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
		signal: result.signal ?? undefined,
	};
}

export async function runAudit(
	dependencies: {
		execute?: () => AuditResult;
		sleep?: (delayMs: number) => Promise<void>;
		writeStdout?: (output: string) => void;
		writeStderr?: (output: string) => void;
	} = {},
): Promise<number> {
	const execute = dependencies.execute ?? executeAudit;
	const sleep = dependencies.sleep ?? Bun.sleep;
	const writeStdout = dependencies.writeStdout ?? ((output) => process.stdout.write(output));
	const writeStderr = dependencies.writeStderr ?? ((output) => process.stderr.write(output));

	for (let attempt = 0; ; attempt++) {
		const result = execute();
		writeStdout(result.stdout);
		writeStderr(result.stderr);
		if (result.errorCode) writeStderr(`Audit process failed (${result.errorCode}).\n`);
		if (!isTransientAuditFailure(result)) return result.exitCode;
		if (attempt === retryDelaysMs.length) {
			writeStderr("Dependency audit could not complete after 3 attempts; verification remains failed.\n");
			return result.exitCode;
		}
		const delayMs = retryDelaysMs[attempt];
		writeStderr(`Audit request failed temporarily; retrying (${attempt + 2}/3) in ${delayMs / 1000}s.\n`);
		await sleep(delayMs);
	}
}

if (import.meta.main) process.exit(await runAudit());

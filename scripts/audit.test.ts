import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AuditResult, isTransientAuditFailure, runAudit } from "./audit.ts";
import { profileSteps } from "./verify.ts";

const connectionClosed: AuditResult = {
	exitCode: 1,
	stdout: "",
	stderr: "bun audit v1.3.5 (1e86cebd)\nConnectionClosed: audit request failed\n",
};
const success: AuditResult = { exitCode: 0, stdout: "No vulnerabilities found\n", stderr: "" };

function auditSequence(results: AuditResult[]) {
	let attempts = 0;
	const delays: number[] = [];
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		get attempts() {
			return attempts;
		},
		delays,
		stdout,
		stderr,
		dependencies: {
			execute: () => {
				const result = results[attempts++];
				if (!result) throw new Error("Unexpected audit attempt");
				return result;
			},
			sleep: async (delayMs: number) => {
				delays.push(delayMs);
			},
			writeStdout: (output: string) => stdout.push(output),
			writeStderr: (output: string) => stderr.push(output),
		},
	};
}

describe("dependency audit retries", () => {
	test("keeps successful audits unchanged without waiting", async () => {
		const sequence = auditSequence([success]);
		expect(await runAudit(sequence.dependencies)).toBe(0);
		expect(sequence.attempts).toBe(1);
		expect(sequence.delays).toEqual([]);
		expect(sequence.stdout).toEqual([success.stdout]);
	});

	test("retries the CI ConnectionClosed error with bounded backoff", async () => {
		const sequence = auditSequence([connectionClosed, connectionClosed, success]);
		expect(await runAudit(sequence.dependencies)).toBe(0);
		expect(sequence.attempts).toBe(3);
		expect(sequence.delays).toEqual([2_000, 5_000]);
		expect(sequence.stderr.join("")).toContain(connectionClosed.stderr);
		expect(sequence.stderr.join("")).toContain("retrying (3/3)");
	});

	test("still fails after three unsuccessful network attempts", async () => {
		const sequence = auditSequence([connectionClosed, connectionClosed, connectionClosed]);
		expect(await runAudit(sequence.dependencies)).toBe(1);
		expect(sequence.attempts).toBe(3);
		expect(sequence.delays).toEqual([2_000, 5_000]);
		expect(sequence.stderr.join("")).toContain("verification remains failed");
	});

	test("does not retry vulnerability findings, even after a transient error", async () => {
		const finding = { exitCode: 1, stdout: "1 vulnerability (1 high)\n", stderr: "" };
		const sequence = auditSequence([connectionClosed, finding]);
		expect(await runAudit(sequence.dependencies)).toBe(1);
		expect(sequence.attempts).toBe(2);
		expect(sequence.delays).toEqual([2_000]);
		expect(sequence.stdout).toContain(finding.stdout);
	});

	test("does not retry unknown errors, auth failures, invalid lockfiles, or interrupted processes", async () => {
		for (const result of [
			{ exitCode: 2, stdout: "", stderr: "error: invalid lockfile\n" },
			{ exitCode: 1, stdout: "", stderr: "HTTP 401 Unauthorized\n" },
			{ exitCode: 1, stdout: "", stderr: "unknown audit error\n" },
			{ ...connectionClosed, errorCode: "ENOENT" },
			{ ...connectionClosed, signal: "SIGINT" },
		]) {
			const sequence = auditSequence([result]);
			expect(await runAudit(sequence.dependencies)).toBe(result.exitCode);
			expect(sequence.attempts).toBe(1);
			expect(sequence.delays).toEqual([]);
		}
	});

	test("handles ANSI banners but does not match errors embedded in vulnerability reports", () => {
		expect(isTransientAuditFailure({ ...connectionClosed, stderr: `\x1b[1m${connectionClosed.stderr}\x1b[0m` })).toBe(
			true,
		);
		expect(isTransientAuditFailure({ ...connectionClosed, stdout: "1 vulnerability (1 high)\n" })).toBe(false);
		expect(
			isTransientAuditFailure({ ...connectionClosed, stderr: "high: ConnectionClosed: audit request failed\n" }),
		).toBe(false);
	});

	test("bounds retries of timed-out audit processes", async () => {
		const timeout = { exitCode: 1, stdout: "", stderr: "", errorCode: "ETIMEDOUT", signal: "SIGTERM" };
		const sequence = auditSequence([timeout, timeout, timeout]);
		expect(await runAudit(sequence.dependencies)).toBe(1);
		expect(sequence.attempts).toBe(3);
		expect(sequence.stderr.join("")).toContain("ETIMEDOUT");
		expect(isTransientAuditFailure({ ...timeout, stdout: "1 vulnerability (1 high)\n" })).toBe(false);
	});

	test("routes both full and release verification through the audit wrapper", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.scripts.audit).toBe("bun scripts/audit.ts");
		expect(profileSteps("full")).toContain("audit");
		expect(profileSteps("release")).toContain("audit");
	});
});

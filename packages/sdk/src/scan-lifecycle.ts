// Provider scan lifecycle: the single source of truth for the file/skill content-audit state
// machine — timeouts, poll cadence, status buckets, numeric↔string mapping, and the generic
// poll loop — shared across the SDK bailian adapter, server warming, and both webui transports.
// Pure (constants + plain functions + setTimeout), no Node/zod deps, so it is safe to import into
// a browser bundle via `@openagentpack/sdk/scan-lifecycle`.

/** Neutral skill scan status. Mirrors ProviderSkillInfo.status / the webui contract SkillStatus. */
export type SkillScanStatus = "checking" | "active" | "rejected" | "deleted";
/** Terminal classification of a scan poll: keep waiting, succeeded, or terminally failed. */
export type ScanPhase = "pending" | "ready" | "failed";

// A fresh custom skill's content scan runs 3–5 min on the production workspace, so the wait must
// clear 5 min with margin. File audit clears faster (~15s–2min observed).
export const SCAN_SKILL_TIMEOUT_MS = 360_000;
export const SCAN_FILE_TIMEOUT_MS = 120_000;
// Warming / console poll cadence: one provider call every 8s keeps load light. Warming is off the
// user's critical path, so cadence matters more than latency.
export const SCAN_POLL_INTERVAL_MS = 8000;

/** Exponential-backoff poll schedule (SDK apply path: tighter first poll, capped growth). */
export interface ScanBackoff {
	initial: number;
	factor: number;
	max: number;
}
export const SKILL_SCAN_BACKOFF: ScanBackoff = { initial: 2000, factor: 2, max: 8000 };
export const FILE_SCAN_BACKOFF: ScanBackoff = { initial: 1000, factor: 1.5, max: 4000 };

// Numeric ISkill(Version).status (console/provider internal) → neutral string. The wire enum is
// 0 checking / 1 active / 2 rejected / 100 deleted.
export const SKILL_STATUS_CODE = { checking: 0, active: 1, rejected: 2, deleted: 100 } as const;
const CODE_TO_SKILL_STATUS: Record<number, SkillScanStatus> = {
	0: "checking",
	1: "active",
	2: "rejected",
	100: "deleted",
};

/** Numeric console skill status → neutral SkillScanStatus (unknown codes read as still-checking). */
export function skillStatusFromCode(code: number | undefined): SkillScanStatus {
	return (code != null ? CODE_TO_SKILL_STATUS[code] : undefined) ?? "checking";
}

// OpenAPI skill status string → neutral SkillScanStatus. Crucially `unsafe` is the security-scan
// FAILURE terminal and must map to `rejected`, NOT `checking` — otherwise a failed skill displays
// as still-scanning forever. (Numeric 2 maps to the same `rejected` bucket via skillStatusFromCode,
// keeping both transports' status display in sync — now by shared code, not a comment contract.)
export function skillStatusFromString(raw: unknown): SkillScanStatus {
	switch (String(raw ?? "").toLowerCase()) {
		case "active":
			return "active";
		case "unsafe":
		case "rejected":
			return "rejected";
		case "deleted":
			return "deleted";
		default:
			return "checking";
	}
}

// File scan: bindable at `available`; `rejected`/`type_rejected` are terminal failures; anything
// else (checking / security_scanning / unknown) keeps polling.
export function classifyFileScan(status: string | undefined): ScanPhase {
	if (status === "available") return "ready";
	if (status === "rejected" || status === "type_rejected") return "failed";
	return "pending";
}

// Skill scan: `active` = ready; `rejected`/`deleted` = terminal failure; `checking`/scanning =
// pending. Pass the neutral status (normalize numeric/raw via skillStatusFrom* first).
export function classifySkillScan(status: string | undefined): ScanPhase {
	if (status === "active") return "ready";
	if (status === "rejected" || status === "deleted") return "failed";
	return "pending";
}

export interface PollUntilOptions<T> {
	/** Fetch the current state once. Called immediately, then after each interval. */
	poll: () => Promise<T>;
	/** Map a polled value to its scan phase. */
	classify: (value: T) => ScanPhase;
	/** Give up after this many ms (measured from the first poll). */
	timeoutMs: number;
	/** Fixed delay between polls, or an exponential-backoff schedule. */
	interval: number | ScanBackoff;
	/** Build the error thrown when classify returns "failed" (terminal rejection). */
	onFailed: (value: T) => Error;
	/** Build the error thrown when timeoutMs elapses (receives the last polled value, if any). */
	onTimeout: (last: T | undefined) => Error;
}

/**
 * Generic content-scan poll loop: poll → resolve on "ready", throw onFailed on "failed", throw
 * onTimeout once the deadline passes, otherwise sleep and retry. Supersedes the four hand-rolled
 * copies (SDK file/skill waits, server warm loops, Mode B waitForActive).
 */
export async function pollUntil<T>(opts: PollUntilOptions<T>): Promise<T> {
	const start = Date.now();
	const fixed = typeof opts.interval === "number";
	let delay = fixed ? (opts.interval as number) : (opts.interval as ScanBackoff).initial;
	let last: T | undefined;
	for (;;) {
		const value = await opts.poll();
		last = value;
		const phase = opts.classify(value);
		if (phase === "ready") return value;
		if (phase === "failed") throw opts.onFailed(value);
		if (Date.now() - start >= opts.timeoutMs) throw opts.onTimeout(last);
		await new Promise((resolve) => setTimeout(resolve, delay));
		if (!fixed) {
			const backoff = opts.interval as ScanBackoff;
			delay = Math.min(delay * backoff.factor, backoff.max);
		}
	}
}

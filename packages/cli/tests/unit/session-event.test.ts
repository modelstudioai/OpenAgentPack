import { describe, expect, test } from "bun:test";
import {
	formatDuration,
	formatTimestamp,
	isTerminalSessionStatus,
	shouldRenderLiveEvent,
} from "../../src/commands/session.ts";

describe("session live rendering", () => {
	test("suppresses user-message echoes", () => {
		expect(
			shouldRenderLiveEvent({
				type: "message",
				raw_type: "message",
				role: "user",
				content: "echoed prompt",
				raw: {},
			}),
		).toBe(false);
	});

	test("keeps assistant messages", () => {
		expect(
			shouldRenderLiveEvent({
				type: "message",
				raw_type: "message",
				role: "assistant",
				content: "answer",
				raw: {},
			}),
		).toBe(true);
	});
});

describe("session terminal statuses", () => {
	test("treats provider terminal states as terminal", () => {
		expect(isTerminalSessionStatus("idle")).toBe(true);
		expect(isTerminalSessionStatus("completed")).toBe(true);
		expect(isTerminalSessionStatus("failed")).toBe(true);
		expect(isTerminalSessionStatus("terminated")).toBe(true);
		expect(isTerminalSessionStatus("deleted")).toBe(true);
	});

	test("keeps active states non-terminal", () => {
		expect(isTerminalSessionStatus("running")).toBe(false);
		expect(isTerminalSessionStatus("processing")).toBe(false);
		expect(isTerminalSessionStatus(undefined)).toBe(false);
	});
});

describe("formatDuration", () => {
	test("seconds only", () => {
		const start = "2026-01-01T00:00:00Z";
		const end = "2026-01-01T00:00:30Z";
		expect(formatDuration(start, end)).toBe("30s");
	});

	test("zero duration", () => {
		const time = "2026-01-01T00:00:00Z";
		expect(formatDuration(time, time)).toBe("0s");
	});

	test("minutes and seconds", () => {
		const start = "2026-01-01T00:00:00Z";
		const end = "2026-01-01T00:01:30Z";
		expect(formatDuration(start, end)).toBe("1m30s");
	});

	test("exactly 60 seconds shows as minutes", () => {
		const start = "2026-01-01T00:00:00Z";
		const end = "2026-01-01T00:01:00Z";
		expect(formatDuration(start, end)).toBe("1m0s");
	});

	test("hours and minutes", () => {
		const start = "2026-01-01T00:00:00Z";
		const end = "2026-01-01T02:30:00Z";
		expect(formatDuration(start, end)).toBe("2h30m");
	});

	test("exactly 1 hour", () => {
		const start = "2026-01-01T00:00:00Z";
		const end = "2026-01-01T01:00:00Z";
		expect(formatDuration(start, end)).toBe("1h0m");
	});

	test("invalid start returns dash", () => {
		expect(formatDuration("not-a-date", "2026-01-01T00:00:00Z")).toBe("-");
	});
});

describe("formatTimestamp", () => {
	test("formats valid ISO string as YYYY-MM-DD HH:MM", () => {
		const result = formatTimestamp("2026-03-15T09:05:00Z");
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(result).toContain("2026-03-15");
	});

	test("invalid date returns original string", () => {
		expect(formatTimestamp("not-a-date")).toBe("not-a-date");
	});
});

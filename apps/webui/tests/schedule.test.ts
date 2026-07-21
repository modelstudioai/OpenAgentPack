import { describe, expect, test } from "bun:test";
import { schedulePresetValue, toCron } from "../src/lib/schedule";

describe("schedule presets", () => {
	const monday = new Date("2026-07-20T12:00:00+08:00");

	test("daily and weekdays preserve their advertised repeat rule", () => {
		expect(schedulePresetValue("daily", monday).repeat).toBe("每天");
		expect(schedulePresetValue("weekdays", monday).repeat).toBe("工作日");
	});

	test("weekly selects the next Monday and produces a Monday cron", () => {
		const preset = schedulePresetValue("weekly", monday);
		expect(preset.repeat).toBe("每周");
		expect(toCron(preset.time, preset.repeat)).toBe("0 9 * * 1");
	});
});

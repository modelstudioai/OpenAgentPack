import { describe, expect, it } from "bun:test";
import { runWarmTasks, type WarmProgress } from "./warm";

describe("runWarmTasks", () => {
	it("reports 0/total first, then ticks done up to total", async () => {
		const seen: WarmProgress[] = [];
		await runWarmTasks([async () => {}, async () => {}], (p) => seen.push({ ...p }));
		expect(seen[0]).toEqual({ done: 0, total: 2 });
		expect(seen[seen.length - 1]).toEqual({ done: 2, total: 2 });
	});

	it("empty task list reports only 0/0", async () => {
		const seen: WarmProgress[] = [];
		await runWarmTasks([], (p) => seen.push({ ...p }));
		expect(seen).toEqual([{ done: 0, total: 0 }]);
	});

	it("swallows a throwing task and still reaches total", async () => {
		const seen: WarmProgress[] = [];
		await runWarmTasks(
			[
				async () => {
					throw new Error("boom");
				},
				async () => {},
			],
			(p) => seen.push({ ...p }),
		);
		expect(seen[seen.length - 1]).toEqual({ done: 2, total: 2 });
	});
});

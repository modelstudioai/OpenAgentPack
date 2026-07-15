import { describe, expect, it } from "bun:test";
import type { ProviderSkillInfo } from "../src/internal/types/skill-info.ts";

describe("ProviderSkillInfo", () => {
	it("models the neutral skill shape", () => {
		const s: ProviderSkillInfo = {
			id: "skill_1",
			name: "demo",
			source: "custom",
			status: "checking",
		};
		expect(s.id).toBe("skill_1");
		expect(s.source).toBe("custom");
	});
});

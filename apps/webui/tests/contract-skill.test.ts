import { describe, expect, it } from "bun:test";
import type { SkillStatus, SkillSummary } from "@/lib/api/contract";

describe("SkillSummary contract", () => {
	it("models a custom skill", () => {
		const status: SkillStatus = "checking";
		const s: SkillSummary = { id: "skill_1", name: "demo", source: "custom", status };
		expect(s.source).toBe("custom");
		expect(s.status).toBe("checking");
	});
});

import { describe, expect, it } from "bun:test";
import * as sdk from "../src/index.ts";

describe("sdk skill public surface", () => {
	it("exports the skill runtime functions", () => {
		expect(typeof sdk.listSkills).toBe("function");
		expect(typeof sdk.getSkillInfo).toBe("function");
		expect(typeof sdk.createSkillFromFileId).toBe("function");
		expect(typeof sdk.deleteSkill).toBe("function");
	});
});

import { describe, expect, it } from "bun:test";
import { toBailianSkillInfo } from "../src/internal/providers/bailian/adapter.ts";

describe("toBailianSkillInfo", () => {
	it("maps snake_case OpenAPI skill to ProviderSkillInfo", () => {
		const info = toBailianSkillInfo({
			id: "skill_1",
			name: "Agents__demo",
			description: "d",
			source: "customer",
			status: "checking",
			latest_version: "1",
			created_at: "2026-06-27T00:00:00Z",
			updated_at: "2026-06-27T00:00:00Z",
		});
		expect(info).toEqual({
			id: "skill_1",
			name: "Agents__demo",
			description: "d",
			source: "custom",
			status: "checking",
			latest_version: "1",
			created_at: "2026-06-27T00:00:00Z",
			updated_at: "2026-06-27T00:00:00Z",
		});
	});

	it("defaults unknown source to official and missing status to checking", () => {
		const info = toBailianSkillInfo({ id: "s2", name: "x" });
		expect(info.source).toBe("official");
		expect(info.status).toBe("checking");
	});
});

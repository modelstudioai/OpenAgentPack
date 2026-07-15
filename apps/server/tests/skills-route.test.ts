import { describe, expect, it } from "bun:test";
import { skillsRoute } from "@/routes/skills";

describe("skills route validation", () => {
	it("rejects upload-file without a file", async () => {
		const res = await skillsRoute.request("/skills/upload-file", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
	});

	it("rejects a non-zip upload-file", async () => {
		const fd = new FormData();
		fd.append("file", new File([new Uint8Array([1, 2, 3])], "demo.txt"));
		const res = await skillsRoute.request("/skills/upload-file", { method: "POST", body: fd });
		expect(res.status).toBe(400);
	});

	it("rejects create without a fileId", async () => {
		const res = await skillsRoute.request("/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects status with non-array skillIds", async () => {
		const res = await skillsRoute.request("/skills/status", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ skillIds: "nope" }),
		});
		expect(res.status).toBe(400);
	});
});

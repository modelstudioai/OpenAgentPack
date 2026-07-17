import { describe, expect, test } from "bun:test";
import { filesRoute } from "@/routes/files";

describe("files route validation", () => {
	test("rejects an upload without a file using the public error envelope", async () => {
		const response = await filesRoute.request("/files", { method: "POST", body: new FormData() });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: { message: "file is required" } });
	});

	test("rejects a status request whose fileIds is not an array", async () => {
		const response = await filesRoute.request("/files/status", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fileIds: "nope" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: { message: "fileIds (string[]) is required" } });
	});
});

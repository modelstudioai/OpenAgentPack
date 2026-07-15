import { describe, expect, test } from "bun:test";
import {
	defaultFileUploadPurpose,
	enrichFileMetadata,
	enrichProviderFileInfo,
	needsFileStatusPoll,
	normalizeWireFileStatus,
} from "../../src/file-lifecycle.ts";

describe("file-lifecycle provider profiles", () => {
	test("qoder: ready → available, bindable immediately, no poll", () => {
		const meta = enrichFileMetadata("qoder", { status: "ready" });
		expect(meta.status).toBe("available");
		expect(meta.available).toBe(true);
		expect(meta.needs_poll).toBe(false);
		expect(normalizeWireFileStatus("qoder", "ready")).toBe("available");
	});

	test("qoder: missing status after upload is bindable", () => {
		const meta = enrichFileMetadata("qoder", {});
		expect(meta.status).toBe("available");
		expect(meta.available).toBe(true);
		expect(meta.needs_poll).toBe(false);
	});

	test("qoder: default upload purpose is session_resource", () => {
		expect(defaultFileUploadPurpose("qoder")).toBe("session_resource");
	});

	test("ark: no wire status → immediately bindable", () => {
		const meta = enrichFileMetadata("ark", {});
		expect(meta.status).toBe("available");
		expect(meta.available).toBe(true);
		expect(meta.needs_poll).toBe(false);
		expect(defaultFileUploadPurpose("ark")).toBe("agent");
	});

	test("bailian: checking stays pending until available", () => {
		const checking = enrichFileMetadata("bailian", { status: "checking" });
		expect(checking.status).toBe("checking");
		expect(checking.available).toBe(false);
		expect(checking.needs_poll).toBe(true);

		const ready = enrichFileMetadata("bailian", { status: "available" });
		expect(ready.available).toBe(true);
		expect(ready.needs_poll).toBe(false);
	});

	test("bailian: list wire without status uses downloadable fallback", () => {
		expect(enrichFileMetadata("bailian", { downloadable: true }).available).toBe(true);
		expect(enrichFileMetadata("bailian", { downloadable: false }).available).toBe(false);
	});

	test("bailian: needs status poll", () => {
		expect(needsFileStatusPoll("bailian")).toBe(true);
		expect(needsFileStatusPoll("qoder")).toBe(false);
	});

	test("enrichProviderFileInfo carries normalized fields on the record", () => {
		const out = enrichProviderFileInfo("qoder", {
			id: "file_1",
			filename: "a.txt",
			mime_type: "text/plain",
			size_bytes: 1,
			created_at: "2026-01-01T00:00:00Z",
			status: "ready",
		});
		expect(out.status).toBe("available");
		expect(out.available).toBe(true);
	});
});

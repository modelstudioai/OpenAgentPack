import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { classifyFileScan, classifySkillScan, skillStatusFromString } from "@openagentpack/sdk/scan-lifecycle";

// ─────────────────────────────────────────────────────────────────────────────
// Scan-lifecycle drift guard. The file/skill content-audit state machine —
// timeouts, poll cadence, and status buckets — used to live as hand-copied
// constants and if-chains across several surfaces (SDK adapter, server warming,
// the ResourceCenter UI), kept aligned only by "Kept in sync" comments. They now
// share one module (@openagentpack/sdk/scan-lifecycle). This test turns the
// comment contracts into assertions so a future edit that forks one copy goes red.
// ─────────────────────────────────────────────────────────────────────────────

describe("string skill status normalization", () => {
	test("the security-scan failure terminal (unsafe / rejected) buckets as failed", () => {
		expect(classifySkillScan(skillStatusFromString("unsafe"))).toBe("failed");
		expect(classifySkillScan(skillStatusFromString("rejected"))).toBe("failed");
	});

	test("unknown strings keep polling rather than reading as terminal", () => {
		expect(skillStatusFromString("security_scanning")).toBe("checking");
		expect(classifySkillScan(skillStatusFromString("security_scanning"))).toBe("pending");
	});
});

describe("terminal classification buckets", () => {
	test("file scan: available=ready, rejected/type_rejected=failed, else pending", () => {
		expect(classifyFileScan("available")).toBe("ready");
		expect(classifyFileScan("rejected")).toBe("failed");
		expect(classifyFileScan("type_rejected")).toBe("failed");
		expect(classifyFileScan("checking")).toBe("pending");
		expect(classifyFileScan(undefined)).toBe("pending");
	});

	test("skill scan: active=ready, rejected/deleted=failed, else pending", () => {
		expect(classifySkillScan("active")).toBe("ready");
		expect(classifySkillScan("rejected")).toBe("failed");
		expect(classifySkillScan("deleted")).toBe("failed");
		expect(classifySkillScan("checking")).toBe("pending");
		expect(classifySkillScan(undefined)).toBe("pending");
	});
});

describe("single-source file bindability (no consumer re-derives available)", () => {
	const repoRoot = resolve(import.meta.dir, "../../..");
	const sharedModule = resolve(repoRoot, "packages/sdk/src/file-lifecycle.ts");
	const consumers = ["apps/webui/src/lib/api/transports/rest.ts", "apps/webui/src/components/FilePickerModal.tsx"].map(
		(p) => resolve(repoRoot, p),
	);

	const FORKABLE = ['status === "available"', "downloadable === true"];

	test("the shared module declares bindability helpers", async () => {
		const src = await Bun.file(sharedModule).text();
		expect(src).toContain("enrichFileMetadata");
		expect(src).toContain("defaultFileUploadPurpose");
	});

	for (const consumer of consumers) {
		test(`${consumer.replace(`${repoRoot}/`, "")} does not re-derive available`, async () => {
			const src = await Bun.file(consumer).text();
			for (const literal of FORKABLE) {
				expect(src).not.toContain(literal);
			}
		});
	}
});

describe("single-source constants (no consumer re-declares them)", () => {
	const repoRoot = resolve(import.meta.dir, "../../..");
	const sharedModule = resolve(repoRoot, "packages/sdk/src/scan-lifecycle.ts");
	const consumers = [
		"packages/sdk/src/internal/providers/bailian/adapter.ts",
		"apps/server/src/services/skills/manage.ts",
		"apps/webui/src/components/resource-center/ResourceCenter.tsx",
	].map((p) => resolve(repoRoot, p));

	// The raw literals that used to be physically copied. They must appear exactly
	// once — in the shared module — and nowhere in the consumers.
	const FORKABLE = ["360_000", "120_000"];

	test("the shared module declares the constants", async () => {
		const src = await Bun.file(sharedModule).text();
		for (const literal of FORKABLE) {
			expect(src).toContain(literal);
		}
	});

	for (const consumer of consumers) {
		test(`${consumer.replace(`${repoRoot}/`, "")} re-declares none of them`, async () => {
			const src = await Bun.file(consumer).text();
			for (const literal of FORKABLE) {
				expect(src).not.toContain(literal);
			}
		});
	}
});

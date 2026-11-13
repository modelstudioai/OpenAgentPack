import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "../../src/redaction.ts";

const SIGNED_OSS_URL =
	"https://dashscope-7c2c.oss-accelerate.aliyuncs.com/7d/1a/20260625/a3584b24/cbb998aa-4525-4994-bfe9-a5da2e50bd44.png?Expires=1782975149&OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1&Signature=Z35W3GbIYmvq2UH6iBF%2FD6GJgSw%3D";

describe("redactSensitiveText", () => {
	test("preserves signed OSS URLs inside markdown image syntax", () => {
		const input = `### 生成产物\n\n![一只可爱的小猫正在喝水](${SIGNED_OSS_URL})`;
		const output = redactSensitiveText(input);

		expect(output).toBe(input);
		expect(output).toContain("OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1");
		expect(output).toContain("Signature=Z35W3GbIYmvq2UH6iBF%2FD6GJgSw%3D");
	});

	test("preserves signed OSS URLs inside markdown media links", () => {
		const videoUrl =
			"https://cdn.example.com/demo.mp4?Expires=123&OSSAccessKeyId=LTAI5tABCDEFGHIJKLMNOP&Signature=abc%3D";
		const input = `[▶ 视频：宣传片](${videoUrl})`;
		const output = redactSensitiveText(input);

		expect(output).toBe(input);
	});

	test("still redacts bare signed OSS URLs in tool output", () => {
		const input =
			"https://oss-cn.aliyuncs.com/bucket/file.zip?OSSAccessKeyId=LTAI5tABCDEFGHIJKLMNOP&Signature=abc%3D&Expires=123";
		const output = redactSensitiveText(input);

		expect(output).not.toContain("LTAI5tABCDEFGHIJKLMNOP");
		expect(output).toContain("[redacted]");
	});

	test("preserves only the destination when a signed URL also appears in the label", () => {
		const output = redactSensitiveText(`[${SIGNED_OSS_URL}](${SIGNED_OSS_URL})`);
		expect(output).toEndWith(`](${SIGNED_OSS_URL})`);
		const label = output.slice(0, output.length - SIGNED_OSS_URL.length - 3);
		expect(label).not.toContain("LTAI5tPxpiCM2hjmWrFXrym1");
		expect(label).not.toContain("Z35W3GbIYmvq2UH6iBF");
		expect(label).toContain("[redacted]");
	});

	test("keeps adjacent image and download destinations while redacting ordinary links and labels", () => {
		const image = "https://cdn.example.test/render?token=image-secret";
		const document = "https://cdn.example.test/report.pdf?signature=document-secret";
		const ordinary = "https://example.test/api?token=ordinary-secret";
		const output = redactSensitiveText(`![token=label-secret](${image})[PDF](${document})[API](${ordinary})`);
		expect(output).toContain(`![token: [redacted]](${image})[PDF](${document})`);
		expect(output).not.toContain("label-secret");
		expect(output).not.toContain("ordinary-secret");
	});

	test("recovers later Markdown labels without preserving malformed destinations", () => {
		const nested = `[](http://[label with spaces](${SIGNED_OSS_URL})`;
		expect(redactSensitiveText(nested)).toBe(nested);
		const input = `[broken](https://example.test/api?token=broken-secret [valid](${SIGNED_OSS_URL})`;
		const output = redactSensitiveText(input);
		expect(output).not.toContain("broken-secret");
		expect(output).toEndWith(`[valid](${SIGNED_OSS_URL})`);
		const invalidNestedLabel = `[outer [inner]](${SIGNED_OSS_URL})`;
		expect(redactSensitiveText(invalidNestedLabel)).not.toContain("LTAI5tPxpiCM2hjmWrFXrym1");
	});

	test.each(["[", "[](http://"])("handles long malformed Markdown beginning with %s", (fragment) => {
		const prefix = fragment.repeat(32_768);
		expect(redactSensitiveText(`${prefix} token=trailing-secret`)).toBe(`${prefix} token: [redacted]`);
	});

	test("preserves many complete media destinations in one redaction pass", () => {
		const input = Array.from(
			{ length: 4096 },
			(_, index) => `[${index}](https://example.test/${index}.png?token=keep)`,
		).join("");
		expect(redactSensitiveText(input)).toBe(input);
	});
});

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
});

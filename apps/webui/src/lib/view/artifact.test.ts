import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@openagentpack/sdk";
import {
	classifyUrl,
	collectDeliveredFiles,
	documentTypeLabel,
	extractArtifacts,
	lastAssistantText,
	preferInlineMarkdownPreview,
	resolveDocumentContent,
} from "./artifact";

function deliveredEvent(artifact: Record<string, unknown>): SessionEvent {
	return { type: "agent.artifact_delivered", metadata: { artifact } } as unknown as SessionEvent;
}

function assistantText(text: string): SessionEvent {
	return {
		type: "message",
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as SessionEvent;
}

function userText(text: string): SessionEvent {
	return {
		type: "message",
		role: "user",
		content: [{ type: "text", text }],
	} as unknown as SessionEvent;
}

describe("classifyUrl", () => {
	test("classifies by extension", () => {
		expect(classifyUrl("https://x.com/a.png")).toBe("image");
		expect(classifyUrl("https://x.com/a.JPEG?sig=1")).toBe("image");
		expect(classifyUrl("https://x.com/a.mp4")).toBe("video");
		expect(classifyUrl("https://x.com/a.html")).toBe("app");
		expect(classifyUrl("https://x.com/a.pdf")).toBe("file");
		expect(classifyUrl("https://x.com/a.zip")).toBe("file");
	});

	test("bare url without extension is an app/webpage", () => {
		expect(classifyUrl("https://my-site.example.com/preview/abc")).toBe("app");
	});

	test("presigned OSS download url is a file, not an app (even for .html)", () => {
		const oss =
			"https://bailian-skill-prod.oss-cn-beijing.aliyuncs.com/download-home/2026-07-08/out_1/index.html?x-oss-date=20260707T164602Z&x-oss-expires=900&x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-credential=LTAI%2F20260707%2Fcn-beijing%2Foss%2Faliyun_v4_request&x-oss-signature=5046a2e75f478ba1d6b46d6c256ada23";
		expect(classifyUrl(oss)).toBe("file");
	});

	test("presigned OSS image url still renders inline as image", () => {
		const oss = "https://x.oss-cn-beijing.aliyuncs.com/a.png?x-oss-signature=abc";
		expect(classifyUrl(oss)).toBe("image");
	});
});

describe("lastAssistantText", () => {
	test("returns the last non-user message text", () => {
		const events = [userText("做三张图"), assistantText("好的"), assistantText("完成：https://x.com/a.png")];
		expect(lastAssistantText(events)).toBe("完成：https://x.com/a.png");
	});

	test("skips user messages and empty assistant messages", () => {
		const events = [assistantText("中间结果"), assistantText(""), userText("再来一张")];
		expect(lastAssistantText(events)).toBe("中间结果");
	});

	test("empty when no assistant text", () => {
		expect(lastAssistantText([userText("hi")])).toBe("");
	});
});

describe("extractArtifacts", () => {
	test("markdown image becomes an image artifact with alt as title", () => {
		const { segments } = extractArtifacts("这是结果 ![小狗](https://x.com/dog.png) 喜欢吗");
		expect(segments).toEqual([
			{ type: "text", content: "这是结果" },
			{ type: "images", artifacts: [{ kind: "image", url: "https://x.com/dog.png", title: "小狗" }] },
			{ type: "text", content: "喜欢吗" },
		]);
	});

	test("bare image url", () => {
		const { segments } = extractArtifacts("产物：https://x.com/a.webp");
		expect(segments).toEqual([
			{ type: "text", content: "产物：" },
			{ type: "images", artifacts: [{ kind: "image", url: "https://x.com/a.webp" }] },
		]);
	});

	test("webpage url classified as app", () => {
		const { segments } = extractArtifacts("已部署：https://site.example.com/landing");
		expect(segments).toEqual([
			{ type: "text", content: "已部署：" },
			{ type: "artifact", artifact: { kind: "app", url: "https://site.example.com/landing" } },
		]);
	});

	test("multiple images collected in order when consecutive", () => {
		const { segments } = extractArtifacts(
			"![1](https://x.com/1.png) ![2](https://x.com/2.png) ![3](https://x.com/3.png)",
		);
		expect(segments).toEqual([
			{
				type: "images",
				artifacts: [
					{ kind: "image", url: "https://x.com/1.png", title: "1" },
					{ kind: "image", url: "https://x.com/2.png", title: "2" },
					{ kind: "image", url: "https://x.com/3.png", title: "3" },
				],
			},
		]);
	});

	test("images split by intervening text", () => {
		const { segments } = extractArtifacts("![1](https://x.com/1.png) 中间 ![2](https://x.com/2.png)");
		expect(segments).toEqual([
			{ type: "images", artifacts: [{ kind: "image", url: "https://x.com/1.png", title: "1" }] },
			{ type: "text", content: "中间" },
			{ type: "images", artifacts: [{ kind: "image", url: "https://x.com/2.png", title: "2" }] },
		]);
	});

	test("pdf as file artifact via markdown link", () => {
		const { segments } = extractArtifacts("报告 [下载](https://x.com/r.pdf)");
		expect(segments).toEqual([
			{ type: "text", content: "报告" },
			{ type: "artifact", artifact: { kind: "file", url: "https://x.com/r.pdf", title: "下载" } },
		]);
	});

	test("file link before summary text preserves order", () => {
		const { segments } = extractArtifacts("📄 [报告.md](https://x.com/r.md)\n\n本次优化完成，已补充摘要。");
		expect(segments).toEqual([
			{ type: "text", content: "📄" },
			{
				type: "artifact",
				artifact: { kind: "file", url: "https://x.com/r.md", title: "报告.md" },
			},
			{ type: "text", content: "本次优化完成，已补充摘要。" },
		]);
	});

	test("deduplicates the same url", () => {
		const { segments } = extractArtifacts("看 https://x.com/a.png 再看 https://x.com/a.png");
		expect(segments).toEqual([
			{ type: "text", content: "看" },
			{ type: "images", artifacts: [{ kind: "image", url: "https://x.com/a.png" }] },
			{ type: "text", content: "再看" },
		]);
	});

	test("strips trailing punctuation from bare urls", () => {
		const { segments } = extractArtifacts("打开 https://site.example.com/x。");
		expect(segments).toEqual([
			{ type: "text", content: "打开" },
			{ type: "artifact", artifact: { kind: "app", url: "https://site.example.com/x" } },
		]);
	});

	test("plain text with no url yields a single text segment", () => {
		const { segments } = extractArtifacts("任务已完成，没有可下载的产物。");
		expect(segments).toEqual([{ type: "text", content: "任务已完成，没有可下载的产物。" }]);
	});

	test("empty text", () => {
		expect(extractArtifacts("")).toEqual({ segments: [] });
	});

	test("urls inside fenced code blocks stay in text, not artifacts", () => {
		const input = [
			"说明如下：",
			"",
			"```python",
			'TARGET_URL = "https://example.com"',
			'FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"',
			"```",
			"",
			"部署地址：https://site.example.com/app",
		].join("\n");
		const { segments } = extractArtifacts(input);
		expect(segments.some((s) => s.type === "artifact")).toBe(true);
		const codeSegment = segments.find((s) => s.type === "text" && s.content.includes("```python"));
		expect(codeSegment).toBeDefined();
		expect(codeSegment?.type === "text" && codeSegment.content).toContain("https://example.com");
		expect(codeSegment?.type === "text" && codeSegment.content).toContain(
			"https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx",
		);
		expect(
			segments.filter(
				(s) =>
					s.type === "artifact" &&
					s.artifact.url.startsWith("https://example.com") &&
					!s.artifact.url.includes("site.example.com"),
			),
		).toHaveLength(0);
	});

	test("urls inside inline code stay in text", () => {
		const { segments } = extractArtifacts("请设置 `FEISHU_WEBHOOK=https://open.feishu.cn/hook/x` 后重试");
		expect(segments.every((s) => s.type === "text")).toBe(true);
		expect(segments.map((s) => (s.type === "text" ? s.content : "")).join("")).toContain(
			"`FEISHU_WEBHOOK=https://open.feishu.cn/hook/x`",
		);
	});

	test("urls inside unclosed fenced blocks stay in text (truncated replies)", () => {
		const input = [
			"说明如下：",
			"",
			"```html",
			'<link rel="preconnect" href="https://fonts.googleapis.com">',
			'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
			"...[truncated]",
		].join("\n");
		const { segments } = extractArtifacts(input);
		expect(segments.some((s) => s.type === "artifact")).toBe(false);
		expect(segments.some((s) => s.type === "text" && s.content.includes("fonts.googleapis.com"))).toBe(true);
	});

	test("urls inside fenced block with same-line closing backticks stay in text", () => {
		const input = '```html\nhref="https://fonts.googleapis.com"```';
		const { segments } = extractArtifacts(input);
		expect(segments.every((s) => s.type === "text")).toBe(true);
		expect(segments[0]?.type === "text" && segments[0].content).toContain("https://fonts.googleapis.com");
	});

	test("html delivery template keeps font urls in the code block only", () => {
		const input = [
			"### 交付文件：`index.html`",
			"",
			"```html",
			"<!DOCTYPE html>",
			'<link rel="preconnect" href="https://cdn.example.test">',
			'<link rel="preconnect" href="https://assets.example.test" crossorigin>',
			'<link href="https://cdn.example.test/styles.css" rel="stylesheet">',
			"```",
			"",
			"预览：https://preview.example.com/page",
		].join("\n");
		const { segments } = extractArtifacts(input);
		const artifacts = segments.filter((s) => s.type === "artifact" || s.type === "images");
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]?.type === "artifact" && artifacts[0].artifact.url).toBe("https://preview.example.com/page");
	});
});

describe("preferInlineMarkdownPreview", () => {
	test("prefers markdown for interleaved article content", () => {
		const { segments } = extractArtifacts(
			[
				"# 标题",
				"",
				"第一段正文内容比较长，介绍人工智能如何改变各行各业的工作方式与协作模式。",
				"",
				"![配图一](https://x.com/1.png)",
				"",
				"第二段继续展开论述，并补充更多案例与细节说明。",
				"",
				"![配图二](https://x.com/2.png)",
			].join("\n"),
		);
		expect(preferInlineMarkdownPreview(segments)).toBe(true);
	});

	test("keeps gallery layout for short image delivery", () => {
		const { segments } = extractArtifacts("产物：https://x.com/a.webp");
		expect(preferInlineMarkdownPreview(segments)).toBe(false);
	});

	test("keeps gallery layout for images-only replies", () => {
		const { segments } = extractArtifacts("![1](https://x.com/1.png) ![2](https://x.com/2.png)");
		expect(preferInlineMarkdownPreview(segments)).toBe(false);
	});

	test("keeps artifact layout when non-image artifacts exist", () => {
		const { segments } = extractArtifacts("说明 ![图](https://x.com/1.png) 以及 [报告](https://x.com/r.pdf)");
		expect(preferInlineMarkdownPreview(segments)).toBe(false);
	});
});

describe("collectDeliveredFiles", () => {
	test("reads the artifact descriptor from event metadata", () => {
		const files = collectDeliveredFiles([
			deliveredEvent({ file_id: "file_1", filename: "a.html", content_type: "text/html", size: 42 }),
		]);
		expect(files).toEqual([{ file_id: "file_1", filename: "a.html", content_type: "text/html", size: 42 }]);
	});

	test("dedupes by file_id, keeping the first occurrence", () => {
		const files = collectDeliveredFiles([
			deliveredEvent({ file_id: "file_1", filename: "first.html" }),
			deliveredEvent({ file_id: "file_1", filename: "dup.html" }),
			deliveredEvent({ file_id: "file_2", filename: "second.html" }),
		]);
		expect(files.map((f) => f.file_id)).toEqual(["file_1", "file_2"]);
		expect(files[0]?.filename).toBe("first.html");
	});

	test("defaults filename to file_id when the provider omits it", () => {
		const files = collectDeliveredFiles([deliveredEvent({ file_id: "file_x" })]);
		expect(files[0]?.filename).toBe("file_x");
	});

	test("ignores events without an artifact descriptor or file_id", () => {
		expect(
			collectDeliveredFiles([
				{ type: "message", role: "assistant" } as unknown as SessionEvent,
				deliveredEvent({ filename: "no-id.html" }),
			]),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Document segment extraction
// ---------------------------------------------------------------------------

/** Generate a realistic HTML document string of a given approximate length. */
function makeHtmlDocument(minChars = 1200): string {
	const body = `<h1>Report Title</h1>\n<p>${"This is a paragraph of report content with data-driven insights. ".repeat(
		Math.ceil(minChars / 60),
	)}</p>`;
	return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>Report</title></head>\n<body>\n${body}\n</body>\n</html>`;
}

/** Generate a Mermaid diagram of a given approximate length. */
function makeMermaidDiagram(minChars = 600): string {
	const nodes = Array.from({ length: Math.ceil(minChars / 50) }, (_, i) => `  N${i}["Node ${i} description text"]`);
	const edges = Array.from({ length: nodes.length - 1 }, (_, i) => `  N${i} --> N${i + 1}`);
	return `graph TD\n${nodes.join("\n")}\n${edges.join("\n")}`;
}

describe("document extraction", () => {
	test("inline HTML document is extracted as a document segment", () => {
		const html = makeHtmlDocument();
		const input = `以下是报告：\n\n${html}`;
		const { segments } = extractArtifacts(input);
		const docs = segments.filter((s) => s.type === "document");
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ type: "document", mimeType: "text/html" });
		// The preamble text should survive as a text segment.
		const texts = segments.filter((s) => s.type === "text");
		expect(texts.some((s) => s.type === "text" && s.content.includes("以下是报告"))).toBe(true);
	});

	test("inline HTML document title is extracted from <title>", () => {
		const html = makeHtmlDocument();
		const input = html;
		const { segments } = extractArtifacts(input);
		const doc = segments.find((s) => s.type === "document");
		expect(doc?.type === "document" ? doc.title : undefined).toBe("Report");
	});

	test("URLs inside an extracted HTML document are NOT extracted as artifacts", () => {
		const html = makeHtmlDocument().replace(
			"</head>",
			'<link href="https://cdn.example.test/styles.css" rel="stylesheet"></head>',
		);
		const { segments } = extractArtifacts(html);
		const artifacts = segments.filter((s) => s.type === "artifact" || s.type === "images");
		expect(artifacts).toHaveLength(0);
	});

	test("short fenced HTML block stays as text (below threshold)", () => {
		const input = [
			"### 交付文件：`index.html`",
			"",
			"```html",
			"<!DOCTYPE html>",
			'<link rel="preconnect" href="https://cdn.example.test">',
			'<link rel="preconnect" href="https://assets.example.test" crossorigin>',
			'<link href="https://cdn.example.test/styles.css" rel="stylesheet">',
			"```",
			"",
			"预览：https://preview.example.com/page",
		].join("\n");
		const { segments } = extractArtifacts(input);
		// The fenced block is too short to be a document — stays as text.
		expect(segments.some((s) => s.type === "text" && s.content.includes("cdn.example.test"))).toBe(true);
		expect(segments.every((s) => s.type !== "document")).toBe(true);
	});

	test("large fenced HTML block is extracted as a document segment", () => {
		const htmlContent = makeHtmlDocument(1000);
		const input = `Report:\n\n\`\`\`html\n${htmlContent}\n\`\`\`\n\nDone.`;
		const { segments } = extractArtifacts(input);
		const docs = segments.filter((s) => s.type === "document");
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ type: "document", mimeType: "text/html" });
		// The preamble and postamble should survive as text segments.
		expect(segments.some((s) => s.type === "text" && s.content.includes("Report:"))).toBe(true);
		expect(segments.some((s) => s.type === "text" && s.content.includes("Done."))).toBe(true);
	});

	test("fenced mermaid block is extracted as a document segment", () => {
		const mermaid = makeMermaidDiagram(600);
		const input = `Diagram:\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\nEnd.`;
		const { segments } = extractArtifacts(input);
		const docs = segments.filter((s) => s.type === "document");
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ type: "document", mimeType: "text/mermaid" });
	});

	test("truncated inline HTML (no </html>) is still extracted as document", () => {
		// Simulate a truncated HTML stream: starts with DOCTYPE but never closes.
		const truncatedHtml = `<!DOCTYPE html>\n<html>\n<head><title>Partial</title></head>\n<body>\n${"<p>content</p>\n".repeat(80)}`;
		const { segments } = extractArtifacts(truncatedHtml);
		const docs = segments.filter((s) => s.type === "document");
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ type: "document", mimeType: "text/html" });
	});

	test("truncated HTML with short preamble is extracted as document", () => {
		// The common agent pattern: "以下是报告：\n\n<!DOCTYPE html>...(truncated)..."
		const preamble = "以下是基于你提供的素材整理而成的 HTML 格式行业研究报告。\n\n";
		const truncatedHtml = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><title>Report</title></head>\n<body>\n${"<p>报告内容段落。</p>\n".repeat(100)}`;
		const input = preamble + truncatedHtml;
		expect(input).not.toMatch(/<\/html>/i); // no closing tag = truncated
		const { segments } = extractArtifacts(input);
		const docs = segments.filter((s) => s.type === "document");
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ type: "document", mimeType: "text/html" });
		// Preamble survives as text.
		const texts = segments.filter((s) => s.type === "text");
		expect(texts.some((s) => s.type === "text" && s.content.includes("以下是基于"))).toBe(true);
	});

	test("preferInlineMarkdownPreview returns false when document segments exist", () => {
		const html = makeHtmlDocument();
		const input = `![img](https://x.com/1.png)\n\nLong text content here for testing.\n\n${html}`;
		const { segments } = extractArtifacts(input);
		expect(preferInlineMarkdownPreview(segments)).toBe(false);
	});
});

describe("resolveDocumentContent", () => {
	test("returns HTML content as-is", () => {
		const html = "<!DOCTYPE html><html><body>Hello</body></html>";
		const result = resolveDocumentContent({ type: "document", content: html, mimeType: "text/html" });
		expect(result).toBe(html);
	});

	test("returns SVG content as-is", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>';
		const result = resolveDocumentContent({ type: "document", content: svg, mimeType: "image/svg+xml" });
		expect(result).toBe(svg);
	});

	test("wraps Mermaid content in an HTML shell with mermaid.js", () => {
		const mermaid = "graph TD\n  A --> B";
		const result = resolveDocumentContent({ type: "document", content: mermaid, mimeType: "text/mermaid" });
		expect(result).toContain("mermaid.min.js");
		expect(result).toContain('<pre class="mermaid">');
		expect(result).toContain("graph TD");
		expect(result).toContain("mermaid.initialize");
	});
});

describe("documentTypeLabel", () => {
	test("returns correct labels", () => {
		expect(documentTypeLabel("text/html")).toBe("HTML 文档");
		expect(documentTypeLabel("image/svg+xml")).toBe("SVG 图形");
		expect(documentTypeLabel("text/mermaid")).toBe("Mermaid 图表");
	});
});

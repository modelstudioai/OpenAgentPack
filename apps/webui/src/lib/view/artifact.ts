import type { SessionEvent } from "@openagentpack/sdk";
import { displayBucketOf, eventText } from "./session-event-display";

export type ArtifactKind = "image" | "video" | "app" | "file";

export interface Artifact {
	kind: ArtifactKind;
	url: string;
	title?: string;
}

// A file the agent delivered to the provider's Files API (qoder DeliverArtifacts). Unlike URL
// artifacts, this carries only a file_id — the download URL is fetched on demand per click.
export interface DeliveredFile {
	file_id: string;
	filename: string;
	content_type?: string;
	size?: number;
}

export type ArtifactSegment =
	| { type: "text"; content: string }
	| { type: "images"; artifacts: Artifact[] }
	| { type: "artifact"; artifact: Artifact }
	| { type: "delivered_file"; file: DeliveredFile }
	| DocumentSegment;

/** MIME type for self-contained rich documents extracted from agent messages. */
export type DocumentMimeType = "text/html" | "image/svg+xml" | "text/mermaid";

/**
 * A self-contained rich document (HTML page, SVG graphic, Mermaid diagram) that the agent
 * produced inline in a chat message. Rendered via sandboxed iframe (`srcdoc`) instead of
 * being sanitized through the Markdown pipeline.
 */
export interface DocumentSegment {
	type: "document";
	/** Raw document source code (HTML / SVG / Mermaid syntax). */
	content: string;
	/** Document MIME, determines how the iframe renders the content. */
	mimeType: DocumentMimeType;
	/** Optional human-readable title (inferred from fence lang tag or `<title>` element). */
	title?: string;
}

export interface ArtifactResult {
	segments: ArtifactSegment[];
}

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|avif|svg|bmp)(?:[?#]|$)/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;
const APP_EXT = /\.html?(?:[?#]|$)/i;
const FILE_EXT = /\.(?:pdf|zip|tar|gz|rar|7z|docx?|xlsx?|pptx?|csv|txt|md|json|xml|ya?ml)(?:[?#]|$)/i;
// Presigned object-storage URLs (Aliyun OSS / S3 v4) are file downloads, not hosted apps: they
// can't be iframed cross-origin and often carry attachment disposition. Inline media (image/video)
// is matched first so presigned images still render; everything else here downloads instead of
// being previewed — notably a presigned index.html from download_file.
const DOWNLOAD_SIG = /[?&](?:x-oss-signature|x-amz-signature)=|response-content-disposition=attachment/i;

export function classifyUrl(url: string): ArtifactKind {
	if (IMAGE_EXT.test(url)) return "image";
	if (VIDEO_EXT.test(url)) return "video";
	if (DOWNLOAD_SIG.test(url)) return "file";
	if (APP_EXT.test(url)) return "app";
	if (FILE_EXT.test(url)) return "file";
	// A bare http(s) URL with no recognized extension is treated as a webpage/app.
	return "app";
}

export function lastAssistantText(events: SessionEvent[]): string {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (displayBucketOf(event) === "message" && event.role !== "user") {
			const text = eventText(event);
			if (text) return text;
		}
	}
	return "";
}

/**
 * Collect the files the agent delivered during the run. The shared SDK sanitizer stamps each
 * artifact-delivery event's structured descriptor onto `metadata.artifact` (see
 * session-event-sanitizer.ts); here we read them across all events, de-dupe by file_id, and default
 * the display name to the file_id when the provider omitted a filename.
 */
export function collectDeliveredFiles(events: SessionEvent[]): DeliveredFile[] {
	const seen = new Set<string>();
	const out: DeliveredFile[] = [];
	for (const event of events) {
		const raw = event.metadata?.artifact;
		if (!raw || typeof raw !== "object") continue;
		const artifact = raw as Record<string, unknown>;
		const fileId = artifact.file_id;
		if (typeof fileId !== "string" || !fileId || seen.has(fileId)) continue;
		seen.add(fileId);
		out.push({
			file_id: fileId,
			filename: typeof artifact.filename === "string" && artifact.filename ? artifact.filename : fileId,
			content_type: typeof artifact.content_type === "string" ? artifact.content_type : undefined,
			size: typeof artifact.size === "number" ? artifact.size : undefined,
		});
	}
	return out;
}

const RE_MD_IMAGE = /!\[([^\]]*)\]\(\s*(\S+?)\s*\)/;
const RE_MD_LINK = /\[([^\]]*)\]\(\s*(\S+?)\s*\)/;
const RE_BARE_URL = /https?:\/\/[^\s<>()[\]"']+/;

// Bare-url and markdown matchers can swallow trailing sentence punctuation; trim it.
function stripUrl(url: string): string {
	return url.replace(/[.,;:!?，。、）)]+$/, "");
}

function normalizeTextSegment(raw: string): string {
	return raw
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

type TokenKind = "image" | "link" | "bare";

interface TokenMatch {
	kind: TokenKind;
	index: number;
	length: number;
	rawUrl: string;
	title?: string;
}

const TOKEN_PRIORITY: Record<TokenKind, number> = {
	image: 0,
	link: 1,
	bare: 2,
};

function findLeftmostToken(text: string, from: number): TokenMatch | null {
	const slice = text.slice(from);
	let best: TokenMatch | null = null;

	const consider = (kind: TokenKind, re: RegExp) => {
		const match = re.exec(slice);
		if (!match) return;
		const index = from + match.index;
		if (best && (index > best.index || (index === best.index && TOKEN_PRIORITY[kind] >= TOKEN_PRIORITY[best.kind]))) {
			return;
		}
		const rawUrl = match[2] ?? match[0];
		const title = match[1];
		best = { kind, index, length: match[0].length, rawUrl, title };
	};

	consider("image", RE_MD_IMAGE);
	consider("link", RE_MD_LINK);
	consider("bare", RE_BARE_URL);

	return best;
}

function artifactFromToken(token: TokenMatch): Artifact {
	const url = stripUrl(token.rawUrl);
	if (token.kind === "image") {
		return { kind: "image", url, title: token.title?.trim() || undefined };
	}
	return { kind: classifyUrl(url), url, title: token.title?.trim() || undefined };
}

type ContentRegion = { kind: "prose"; text: string } | { kind: "code"; text: string };

const RE_INLINE_CODE = /`[^`\n]+`/g;

type FenceSpan = { start: number; end: number; text: string; lang: string };

/**
 * Locate fenced ``` blocks. Handles:
 * - closing fence on its own line (CommonMark)
 * - closing fence on the same line as the last content line (common LLM output)
 * - unclosed opening fence running to EOF (streamed / truncated replies)
 */
function findFencedCodeBlocks(text: string): FenceSpan[] {
	const blocks: FenceSpan[] = [];
	const lines = text.split(/\r?\n/);
	let offset = 0;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const open = line.match(/^(`{3,})([^`]*)$/);
		if (!open) {
			offset += line.length + 1;
			i += 1;
			continue;
		}

		const tickCount = open[1].length;
		const lang = (open[2] ?? "").trim().split(/\s+/)[0] ?? "";
		const start = offset;
		offset += line.length + 1;
		i += 1;

		let closed = false;
		while (i < lines.length) {
			const closeLine = lines[i] ?? "";
			const lineStart = offset;

			const closeOnly = closeLine.match(/^(`{3,})\s*$/);
			if (closeOnly && closeOnly[1].length >= tickCount) {
				const end = offset + closeLine.length;
				blocks.push({ start, end, text: text.slice(start, end), lang });
				offset = end + 1;
				i += 1;
				closed = true;
				break;
			}

			// `href="https://…"``` — closing backticks on the same line as code.
			const inlineClose = closeLine.match(/(`{3,})\s*$/);
			if (inlineClose && (inlineClose.index ?? 0) > 0 && inlineClose[1].length >= tickCount) {
				const end = lineStart + (inlineClose.index ?? 0) + inlineClose[1].length;
				blocks.push({ start, end, text: text.slice(start, end), lang });
				offset = end + 1;
				i += 1;
				closed = true;
				break;
			}

			offset += closeLine.length + 1;
			i += 1;
		}

		if (!closed) {
			blocks.push({ start, end: text.length, text: text.slice(start), lang });
			break;
		}
	}

	return blocks;
}

/** Split markdown into prose vs code (fenced blocks + inline backticks). */
function splitContentRegions(text: string): ContentRegion[] {
	const fences = findFencedCodeBlocks(text);
	const regions: ContentRegion[] = [];
	let cursor = 0;

	const pushProseSlice = (slice: string) => {
		if (!slice) return;
		let proseCursor = 0;
		for (const match of slice.matchAll(RE_INLINE_CODE)) {
			const start = match.index ?? 0;
			if (proseCursor < start) {
				regions.push({ kind: "prose", text: slice.slice(proseCursor, start) });
			}
			regions.push({ kind: "code", text: match[0] });
			proseCursor = start + match[0].length;
		}
		if (proseCursor < slice.length) {
			regions.push({ kind: "prose", text: slice.slice(proseCursor) });
		}
	};

	for (const fence of fences) {
		if (cursor < fence.start) {
			pushProseSlice(text.slice(cursor, fence.start));
		}
		regions.push({ kind: "code", text: fence.text });
		cursor = fence.end;
	}

	if (cursor < text.length) {
		pushProseSlice(text.slice(cursor));
	}

	return regions.length > 0 ? regions : [{ kind: "prose", text }];
}

function extractArtifactsFromProse(
	text: string,
	state: {
		segments: ArtifactSegment[];
		seen: Set<string>;
		pendingImages: Artifact[];
		pushText: (raw: string) => void;
		flushImages: () => void;
	},
): void {
	let cursor = 0;

	while (cursor < text.length) {
		const token = findLeftmostToken(text, cursor);
		if (!token) {
			state.pushText(text.slice(cursor));
			break;
		}

		state.pushText(text.slice(cursor, token.index));

		const url = stripUrl(token.rawUrl);
		if (/^https?:\/\//i.test(url) && !state.seen.has(url)) {
			state.seen.add(url);
			const artifact = artifactFromToken(token);
			if (artifact.kind === "image") {
				state.pendingImages.push(artifact);
			} else {
				state.flushImages();
				state.segments.push({ type: "artifact", artifact });
			}
		}

		cursor = token.index + token.length;
	}
}

// ---------------------------------------------------------------------------
// Document detection — self-contained rich documents (HTML / SVG / Mermaid)
// ---------------------------------------------------------------------------

/** Fenced code block languages that represent a renderable document rather than source code. */
const DOCUMENT_LANGUAGES = new Set(["html", "htm", "svg", "mermaid"]);

const LANG_TO_MIME: Record<string, DocumentMimeType> = {
	html: "text/html",
	htm: "text/html",
	svg: "image/svg+xml",
	mermaid: "text/mermaid",
};

/** Minimum character count for a fenced document block (avoids extracting short code snippets). */
const MIN_FENCED_DOCUMENT_CHARS = 500;

/**
 * Matches a complete inline HTML document: `<!DOCTYPE html>…</html>` or `<html…>…</html>`.
 * Uses a non-greedy match on the closing tag to handle multiple HTML blocks in theory,
 * though in practice a single document per message is the common case.
 */
const RE_INLINE_HTML_DOC = /<!DOCTYPE\s+html[^>]*>[\s\S]*?<\/html\s*>/i;

/** Minimum character count for an inline HTML document. */
const MIN_INLINE_HTML_CHARS = 1000;

interface DocumentSpan {
	start: number;
	end: number;
	segment: DocumentSegment;
}

/** Extract the `<title>…</title>` text from an HTML string, if present. */
function extractHtmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
	return match?.[1]?.trim() || undefined;
}

/**
 * Scan the full message text for self-contained document blocks:
 *   1. Fenced code blocks whose language tag is a document language (html/svg/mermaid)
 *      and whose inner content meets the minimum size threshold.
 *   2. Inline HTML documents (`<!DOCTYPE html>…</html>`) not already inside a fence.
 *
 * Returns spans sorted by start position. The caller removes them from the text before
 * running URL extraction on the remaining prose.
 */
function extractDocumentSpans(text: string): DocumentSpan[] {
	const spans: DocumentSpan[] = [];
	const fences = findFencedCodeBlocks(text);

	for (const fence of fences) {
		if (!DOCUMENT_LANGUAGES.has(fence.lang.toLowerCase())) continue;

		// Inner content = everything between the opening and closing fence lines.
		const firstNewline = fence.text.indexOf("\n");
		const innerText = firstNewline >= 0 ? fence.text.slice(firstNewline + 1) : "";
		// Strip trailing closing fence line (```) if present.
		const cleaned = innerText.replace(/```+\s*$/, "").trim();
		if (cleaned.length < MIN_FENCED_DOCUMENT_CHARS) continue;

		const mime = LANG_TO_MIME[fence.lang.toLowerCase()];
		if (!mime) continue;

		spans.push({
			start: fence.start,
			end: fence.end,
			segment: { type: "document", content: cleaned, mimeType: mime },
		});
	}

	// Inline HTML documents — only look in prose regions not covered by a fence.
	const fencedRanges = fences.map((f) => ({ start: f.start, end: f.end }));
	const isInsideFence = (start: number) => fencedRanges.some((r) => start >= r.start && start < r.end);

	// Strategy: search the full text for RE_INLINE_HTML_DOC first (complete documents).
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const match = RE_INLINE_HTML_DOC.exec(text.slice(searchFrom));
		if (!match) break;
		const absStart = searchFrom + match.index;
		if (!isInsideFence(absStart) && match[0].length >= MIN_INLINE_HTML_CHARS) {
			spans.push({
				start: absStart,
				end: absStart + match[0].length,
				segment: {
					type: "document",
					content: match[0],
					mimeType: "text/html",
					title: extractHtmlTitle(match[0]),
				},
			});
			searchFrom = absStart + match[0].length;
			continue;
		}
		searchFrom = absStart + 1;
	}

	// Truncated HTML document: DOCTYPE/<html present but no closing tag (stream was cut).
	// Handles the common case where the agent writes a short preamble ("以下是报告：")
	// before the HTML document, and the stream is truncated mid-document.
	if (!spans.some((s) => s.segment.mimeType === "text/html")) {
		const hasClosing = /<\/html\s*>/i.test(text);
		if (!hasClosing) {
			// Look for DOCTYPE or <html anywhere in the text (not just at position 0).
			const docStartMatch = /<!DOCTYPE\s+html|<html[\s>]/i.exec(text);
			if (docStartMatch) {
				const docStart = docStartMatch.index;
				// Only treat as a document if the preamble is short (< 300 chars) and
				// the HTML content is substantial — avoids false positives on articles
				// that merely mention HTML in passing.
				const htmlContentLen = text.length - docStart;
				if (docStart < 300 && htmlContentLen >= MIN_INLINE_HTML_CHARS && !isInsideFence(docStart)) {
					spans.push({
						start: docStart,
						end: text.length,
						segment: {
							type: "document",
							content: text.slice(docStart),
							mimeType: "text/html",
							title: extractHtmlTitle(text),
						},
					});
				}
			}
		}
	}

	spans.sort((a, b) => a.start - b.start);
	return spans;
}

/** Human-readable label for a document MIME type (used as fallback title in UI). */
export function documentTypeLabel(mimeType: DocumentMimeType): string {
	switch (mimeType) {
		case "text/html":
			return "HTML 文档";
		case "image/svg+xml":
			return "SVG 图形";
		case "text/mermaid":
			return "Mermaid 图表";
	}
}

/**
 * Resolve a document segment into a complete HTML string suitable for `<iframe srcDoc>`.
 * HTML and SVG documents are returned as-is (SVG is self-rendering in browsers).
 * Mermaid syntax is wrapped in a minimal HTML shell that loads mermaid.js from CDN.
 */
export function resolveDocumentContent(segment: DocumentSegment): string {
	if (segment.mimeType === "text/mermaid") {
		return [
			"<!DOCTYPE html>",
			'<html><head><meta charset="UTF-8">',
			'<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>',
			"<style>body{margin:16px;font-family:system-ui,sans-serif}</style>",
			"</head><body>",
			'<pre class="mermaid">',
			segment.content,
			"</pre>",
			"<script>mermaid.initialize({startOnLoad:true})</script>",
			"</body></html>",
		].join("\n");
	}
	// HTML and SVG documents are self-contained.
	return segment.content;
}

export function extractArtifacts(text: string): ArtifactResult {
	if (!text) return { segments: [] };

	// Pass 1: extract self-contained document blocks (HTML / SVG / Mermaid).
	const docSpans = extractDocumentSpans(text);

	if (docSpans.length > 0) {
		// Build ordered list of text slices and document segments.
		const allSegments: ArtifactSegment[] = [];
		let cursor = 0;

		for (const span of docSpans) {
			if (cursor < span.start) {
				const slice = text.slice(cursor, span.start);
				allSegments.push(...extractNonDocumentArtifacts(slice).segments);
			}
			allSegments.push(span.segment);
			cursor = span.end;
		}

		if (cursor < text.length) {
			allSegments.push(...extractNonDocumentArtifacts(text.slice(cursor)).segments);
		}

		return { segments: allSegments };
	}

	// No documents found — use the standard URL extraction pipeline.
	return extractNonDocumentArtifacts(text);
}

/**
 * Standard artifact extraction for text that has already had document blocks removed.
 * Extracts URLs (images, links, bare URLs) from prose regions and preserves fenced code
 * blocks as plain text segments.
 */
function extractNonDocumentArtifacts(text: string): ArtifactResult {
	if (!text) return { segments: [] };

	const bag = {
		segments: [] as ArtifactSegment[],
		seen: new Set<string>(),
		pendingImages: [] as Artifact[],
		pushText(raw: string) {
			const content = normalizeTextSegment(raw);
			if (!content) return;
			bag.flushImages();
			bag.segments.push({ type: "text", content });
		},
		flushImages() {
			if (bag.pendingImages.length === 0) return;
			bag.segments.push({ type: "images", artifacts: bag.pendingImages });
			bag.pendingImages = [];
		},
	};

	for (const region of splitContentRegions(text)) {
		if (region.kind === "code") {
			bag.pushText(region.text);
			continue;
		}
		extractArtifactsFromProse(region.text, bag);
	}

	bag.flushImages();
	return { segments: bag.segments };
}

/**
 * Mixed article replies (long prose with inline figures) render better as full
 * markdown — same as the chat timeline. Standalone image deliveries keep the
 * gallery / artifact layout.
 */
export function preferInlineMarkdownPreview(segments: ArtifactSegment[]): boolean {
	if (!segments.some((s) => s.type === "images")) return false;
	if (segments.some((s) => s.type === "artifact" || s.type === "document")) return false;

	const textSegments = segments.filter((s) => s.type === "text");
	if (textSegments.length === 0) return false;

	const totalTextLen = textSegments.reduce((sum, s) => sum + s.content.length, 0);
	const imageBlockCount = segments.filter((s) => s.type === "images").length;

	if (imageBlockCount >= 2) return true;
	if (segments.length >= 3 && totalTextLen >= 80) return true;
	return false;
}

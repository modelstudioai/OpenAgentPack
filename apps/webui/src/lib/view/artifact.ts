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
	| { type: "delivered_file"; file: DeliveredFile };

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

type FenceSpan = { start: number; end: number; text: string };

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
				blocks.push({ start, end, text: text.slice(start, end) });
				offset = end + 1;
				i += 1;
				closed = true;
				break;
			}

			// `href="https://…"``` — closing backticks on the same line as code.
			const inlineClose = closeLine.match(/(`{3,})\s*$/);
			if (inlineClose && (inlineClose.index ?? 0) > 0 && inlineClose[1].length >= tickCount) {
				const end = lineStart + (inlineClose.index ?? 0) + inlineClose[1].length;
				blocks.push({ start, end, text: text.slice(start, end) });
				offset = end + 1;
				i += 1;
				closed = true;
				break;
			}

			offset += closeLine.length + 1;
			i += 1;
		}

		if (!closed) {
			blocks.push({ start, end: text.length, text: text.slice(start) });
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

export function extractArtifacts(text: string): ArtifactResult {
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
	if (segments.some((s) => s.type === "artifact")) return false;

	const textSegments = segments.filter((s) => s.type === "text");
	if (textSegments.length === 0) return false;

	const totalTextLen = textSegments.reduce((sum, s) => sum + s.content.length, 0);
	const imageBlockCount = segments.filter((s) => s.type === "images").length;

	if (imageBlockCount >= 2) return true;
	if (segments.length >= 3 && totalTextLen >= 80) return true;
	return false;
}

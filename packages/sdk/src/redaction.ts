// Pure secret-redaction helpers shared across transports (server-side sanitizer
// and browser-side normalizers). Regex/URL only — no Node or zod deps,
// so this module is safe to import into a browser bundle via `@openagentpack/sdk/redaction`.

const REDACTED = "[redacted]";

const SENSITIVE_QUERY_KEYS = new Set([
	"access_key",
	"access_key_id",
	"accesskeyid",
	"api_key",
	"apikey",
	"authorization",
	"credential",
	"expires",
	"ossaccesskeyid",
	"policy",
	"security-token",
	"signature",
	"token",
	"x-oss-access-key-id",
	"x-oss-credential",
	"x-oss-date",
	"x-oss-expires",
	"x-oss-security-token",
	"x-oss-signature",
	"x-amz-credential",
	"x-amz-date",
	"x-amz-expires",
	"x-amz-security-token",
	"x-amz-signature",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "avi", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "opus"]);
// 用户可点击下载的产物链接（PDF / 压缩包 / Office 等）需保留 OSS 签名参数，否则链接失效。
const DOWNLOAD_EXTENSIONS = new Set([
	"pdf",
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"csv",
	"txt",
	"md",
	"json",
	"epub",
	"html",
]);

const MEDIA_URL_PLACEHOLDER_RE = /__AGENTS_PRESERVED_MEDIA_URL_(0|[1-9][0-9]*)__/g;

export function redactSensitiveText(value: string): string {
	const preservedUrls: string[] = [];
	const withPlaceholders = preserveMarkdownMediaUrls(value, preservedUrls);

	return redactKeyValuePairs(redactUrls(withPlaceholders)).replace(
		MEDIA_URL_PLACEHOLDER_RE,
		(match, index: string) => preservedUrls[Number(index)] ?? match,
	);
}

/** Preserve Markdown destinations with monotonic scans, including on malformed input. */
function preserveMarkdownMediaUrls(value: string, preservedUrls: string[]): string {
	const parts: string[] = [];
	let scanFrom = 0;
	let copyFrom = 0;
	let urlEnd = -1;
	while (scanFrom < value.length) {
		const labelStart = value.indexOf("[", scanFrom);
		if (labelStart === -1) break;
		const labelEnd = value.indexOf("]", labelStart + 1);
		if (labelEnd === -1) break;
		// Every nested opening bracket before this closing bracket shares its destination.
		scanFrom = labelEnd + 1;
		if (value[scanFrom] !== "(") continue;
		const urlStart = scanFrom + 1;
		const schemeLength = value.startsWith("https://", urlStart) ? 8 : value.startsWith("http://", urlStart) ? 7 : 0;
		if (!schemeLength) continue;
		const contentStart = urlStart + schemeLength;
		// Reuse the scanned suffix when another candidate begins inside an unclosed URL.
		// Otherwise repeated `[](http://` would repeatedly scan the entire remaining input.
		if (urlEnd < contentStart) {
			urlEnd = contentStart;
			while (urlEnd < value.length && value[urlEnd] !== ")" && !/\s/.test(value[urlEnd]!)) urlEnd++;
		}
		if (urlEnd === contentStart || value[urlEnd] !== ")") continue;
		scanFrom = urlEnd + 1;
		const url = value.slice(urlStart, urlEnd);
		if (!shouldPreserveMarkdownMediaUrl(url, labelStart > 0 && value[labelStart - 1] === "!")) continue;
		parts.push(value.slice(copyFrom, urlStart), mediaUrlPlaceholder(preservedUrls.length));
		preservedUrls.push(url);
		copyFrom = urlEnd;
	}
	parts.push(value.slice(copyFrom));
	return parts.join("");
}

function mediaUrlPlaceholder(index: number): string {
	return `__AGENTS_PRESERVED_MEDIA_URL_${index}__`;
}

function shouldPreserveMarkdownMediaUrl(url: string, isImageSyntax: boolean): boolean {
	if (isImageSyntax) return true;
	const ext = mediaExtensionFromUrl(url);
	if (!ext) return false;
	return (
		IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || DOWNLOAD_EXTENSIONS.has(ext)
	);
}

function mediaExtensionFromUrl(url: string): string | null {
	try {
		const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
		return match ? match[1]!.toLowerCase() : null;
	} catch {
		return null;
	}
}

function redactUrls(value: string): string {
	return value.replace(/https?:\/\/[^\s)\]'"<>]+/g, (candidate) => {
		try {
			const url = new URL(candidate);
			let redacted = false;
			for (const key of Array.from(url.searchParams.keys())) {
				if (isSensitiveQueryKey(key)) {
					url.searchParams.set(key, REDACTED);
					redacted = true;
				}
			}
			return redacted ? url.toString() : candidate;
		} catch {
			return candidate;
		}
	});
}

function redactKeyValuePairs(value: string): string {
	return value.replace(
		/\b(api[_-]?key|access[_-]?key(?:_id)?|authorization|credential|ossaccesskeyid|secret|signature|token)\b\s*[:=]\s*["']?[^"',\s)}\]]+/gi,
		(_match, key: string) => `${key}: ${REDACTED}`,
	);
}

function isSensitiveQueryKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return SENSITIVE_QUERY_KEYS.has(normalized) || normalized.startsWith("x-oss-") || normalized.startsWith("x-amz-");
}

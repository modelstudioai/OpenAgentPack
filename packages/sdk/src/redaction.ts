// Pure secret-redaction helpers shared across transports (server-side sanitizer
// and the browser-side console-direct normalizer). Regex/URL only — no Node or zod deps,
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

/** Markdown image/link destinations: `![alt](url)` or `[label](url)`. */
const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

export function redactSensitiveText(value: string): string {
	const preservedUrls: string[] = [];
	const withPlaceholders = value.replace(MARKDOWN_LINK_RE, (match, url: string) => {
		if (!shouldPreserveMarkdownMediaUrl(url, match.startsWith("!"))) {
			return match;
		}
		const index = preservedUrls.length;
		preservedUrls.push(url);
		return match.replace(url, mediaUrlPlaceholder(index));
	});

	let result = redactKeyValuePairs(redactUrls(withPlaceholders));
	for (let i = 0; i < preservedUrls.length; i++) {
		result = result.replaceAll(mediaUrlPlaceholder(i), preservedUrls[i]!);
	}
	return result;
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

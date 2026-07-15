import { useEffect, useState } from "react";
import { isArtifactUrlExpired } from "@/lib/artifact-url-expiry";

export type HtmlArtifactPreviewState = "loading" | "ready" | "fallback" | "expired";

interface HtmlArtifactPreview {
	html: string | null;
	state: HtmlArtifactPreviewState;
}

/**
 * OSS「下载」通道返回的 HTML 常带 Content-Disposition: attachment，
 * 直接用作 iframe src 或新窗口 href 会触发下载。先 fetch 正文再 srcdoc / Blob 预览。
 */
export function useHtmlArtifactPreview(url: string): HtmlArtifactPreview {
	const [html, setHtml] = useState<string | null>(null);
	const [state, setState] = useState<HtmlArtifactPreviewState>("loading");

	useEffect(() => {
		let cancelled = false;
		setHtml(null);

		if (isArtifactUrlExpired(url)) {
			setState("expired");
			return;
		}

		setState("loading");

		void (async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(String(res.status));
				const text = await res.text();
				if (cancelled) return;
				setHtml(text);
				setState("ready");
			} catch {
				if (cancelled) return;
				setState("fallback");
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [url]);

	return { html, state };
}

/** 用 Blob URL 在新窗口内联打开 HTML，避免 attachment 响应头触发下载 */
export async function openHtmlArtifactInNewWindow(url: string, html?: string | null): Promise<void> {
	if (isArtifactUrlExpired(url) && !html) return;
	const openBlob = (content: string) => {
		const blob = new Blob([content], { type: "text/html;charset=utf-8" });
		const blobUrl = URL.createObjectURL(blob);
		window.open(blobUrl, "_blank", "noopener,noreferrer");
		window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
	};

	if (html) {
		openBlob(html);
		return;
	}

	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error(String(res.status));
		openBlob(await res.text());
	} catch {
		window.open(url, "_blank", "noopener,noreferrer");
	}
}

/** 产物展示名：优先 markdown 标题，否则取 URL 路径末段 */
export function artifactDisplayName(url: string, title?: string | null): string {
	const trimmedTitle = title?.trim();
	if (trimmedTitle) return trimmedTitle;
	try {
		const path = new URL(url).pathname;
		const name = path.split("/").filter(Boolean).pop();
		return name ? decodeURIComponent(name) : url;
	} catch {
		return url;
	}
}

/** 追问 Agent 重新签发下载链接时携带的文件名 */
export function buildRegenerateDownloadLinkMessage(fileName: string): string {
	return `重新生成下载链接：${fileName}`;
}

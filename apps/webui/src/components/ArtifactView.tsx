import { Check, Copy, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { useArtifactAccess } from "@/lib/artifact-access-context";
import { artifactDisplayName } from "@/lib/artifact-file-name";
import { getFileDownloadUrl } from "@/lib/domain/file-api";
import { openHtmlArtifactInNewWindow, useHtmlArtifactPreview } from "@/lib/hooks/useHtmlArtifactPreview";
import { MarkdownRenderer } from "@/lib/markdown-renderer";
import {
	type Artifact,
	type ArtifactSegment,
	type DeliveredFile,
	preferInlineMarkdownPreview,
} from "@/lib/view/artifact";

interface ArtifactViewProps {
	segments: ArtifactSegment[];
	/** Rendered when there are no URL artifacts (e.g. pure-text tasks). */
	fallbackMarkdown: string;
}

function ExpiredMediaPlaceholder({ fileName, onRegenerate }: { fileName: string; onRegenerate: () => void }) {
	return (
		<button type="button" className="artifact-media-expired artifact-media-expired-block" onClick={onRegenerate}>
			<span className="artifact-expired-badge">已过期</span>
			<span className="artifact-media-expired-label">{fileName}</span>
			<span className="artifact-media-expired-hint">点击重新生成下载链接</span>
		</button>
	);
}

function ImageGallery({ images }: { images: Artifact[] }) {
	const access = useArtifactAccess();
	const [index, setIndex] = useState(0);
	const active = images[index] ?? images[0];
	const activeName = artifactDisplayName(active.url, active.title);
	const activeExpired = access?.isUrlExpired(active.url) ?? false;

	const openActive = (event: MouseEvent) => {
		event.preventDefault();
		access?.tryOpenUrl(active.url, activeName);
	};

	return (
		<div className="artifact-gallery">
			{activeExpired ? (
				<ExpiredMediaPlaceholder
					fileName={activeName}
					onRegenerate={() => access?.promptRegenerate(active.url, activeName)}
				/>
			) : (
				<a
					className="artifact-main-link"
					href={active.url}
					target="_blank"
					rel="noopener noreferrer"
					onClick={openActive}
				>
					<img className="artifact-main-img" src={active.url} alt={active.title ?? "产物"} />
				</a>
			)}
			{images.length > 1 && (
				<div className="artifact-thumbs">
					{images.map((img, i) => {
						const expired = access?.isUrlExpired(img.url) ?? false;
						return (
							<button
								key={img.url}
								type="button"
								className={`artifact-thumb ${i === index ? "active" : ""} ${expired ? "expired" : ""}`}
								onClick={() => setIndex(i)}
								aria-label={`预览 ${i + 1}`}
							>
								{expired ? (
									<span className="artifact-thumb-expired">过期</span>
								) : (
									<img src={img.url} alt={img.title ?? `缩略图${i + 1}`} />
								)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

function FrameToolbar({
	url,
	html,
	fileName,
	expired,
}: {
	url: string;
	html: string | null;
	fileName: string;
	expired: boolean;
}) {
	const access = useArtifactAccess();
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard may be unavailable (insecure context); the open-in-new link still works.
		}
	};
	const openInNewWindow = (event: MouseEvent) => {
		event.preventDefault();
		if (expired) {
			access?.promptRegenerate(url, fileName);
			return;
		}
		void openHtmlArtifactInNewWindow(url, html);
	};
	return (
		<div className="artifact-frame-bar">
			<span className={`artifact-frame-url ${expired ? "expired" : ""}`} title={url}>
				{url}
			</span>
			{expired && <span className="artifact-expired-badge">已过期</span>}
			<button type="button" className="artifact-frame-btn" onClick={copy}>
				{copied ? <Check size={14} /> : <Copy size={14} />}
				{copied ? "已复制" : "复制链接"}
			</button>
			<button type="button" className="artifact-frame-btn" onClick={openInNewWindow}>
				<ExternalLink size={14} />
				{expired ? "重新生成" : "新窗口打开"}
			</button>
		</div>
	);
}

function WebFrame({ artifact }: { artifact: Artifact }) {
	const access = useArtifactAccess();
	const fileName = artifactDisplayName(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;
	const { html, state } = useHtmlArtifactPreview(artifact.url);
	const title = artifact.title ?? "网页产物";

	if (expired || state === "expired") {
		return (
			<div className="artifact-frame-wrap expired">
				<FrameToolbar url={artifact.url} html={null} fileName={fileName} expired />
				<ExpiredMediaPlaceholder
					fileName={fileName}
					onRegenerate={() => access?.promptRegenerate(artifact.url, fileName)}
				/>
			</div>
		);
	}

	return (
		<div className="artifact-frame-wrap">
			<FrameToolbar url={artifact.url} html={html} fileName={fileName} expired={false} />
			{state === "loading" && (
				<div className="artifact-frame-loading">
					<Loader2 size={20} className="artifact-frame-spinner" aria-hidden />
					<span>正在加载预览…</span>
				</div>
			)}
			{state === "ready" && html && (
				<iframe
					className="artifact-frame"
					srcDoc={html}
					title={title}
					sandbox="allow-scripts allow-popups allow-forms allow-same-origin"
				/>
			)}
			{state === "fallback" && (
				<>
					<p className="artifact-frame-hint">无法拉取页面内容，已回退为直接加载链接（可能触发下载）。</p>
					<iframe
						className="artifact-frame"
						src={artifact.url}
						title={title}
						sandbox="allow-scripts allow-popups allow-forms allow-same-origin"
					/>
				</>
			)}
		</div>
	);
}

function FileCard({ artifact }: { artifact: Artifact }) {
	const access = useArtifactAccess();
	const fileName = artifactDisplayName(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;

	const onOpen = (event: MouseEvent) => {
		event.preventDefault();
		access?.tryOpenUrl(artifact.url, fileName);
	};

	if (expired) {
		return (
			<button type="button" className="artifact-file-card expired" onClick={onOpen}>
				<FileText size={20} />
				<span className="artifact-file-name">{fileName}</span>
				<span className="artifact-expired-badge">已过期</span>
			</button>
		);
	}

	return (
		<a className="artifact-file-card" href={artifact.url} target="_blank" rel="noopener noreferrer" onClick={onOpen}>
			<FileText size={20} />
			<span className="artifact-file-name">{fileName}</span>
			<ExternalLink size={15} className="artifact-file-open" />
		</a>
	);
}

function VideoArtifact({ artifact }: { artifact: Artifact }) {
	const access = useArtifactAccess();
	const fileName = artifactDisplayName(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;

	if (expired) {
		return (
			<ExpiredMediaPlaceholder
				fileName={fileName}
				onRegenerate={() => access?.promptRegenerate(artifact.url, fileName)}
			/>
		);
	}

	return (
		<video className="artifact-video" src={artifact.url} controls playsInline preload="metadata">
			<track kind="captions" />
			您的浏览器不支持视频播放。
		</video>
	);
}

function formatFileSize(bytes?: number): string {
	if (!bytes || bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file the agent delivered to the provider's Files API. It has no standing URL — clicking fetches
 * a fresh presigned download URL on demand (so it never expires in the UI) and opens it.
 */
function DeliveredFileCard({ file }: { file: DeliveredFile }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const size = formatFileSize(file.size);

	const onDownload = async (event: MouseEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const url = await getFileDownloadUrl(file.file_id);
			window.open(url, "_blank", "noopener,noreferrer");
		} catch (err) {
			setError(err instanceof Error ? err.message : "下载失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="artifact-files">
			<button type="button" className="artifact-file-card" onClick={onDownload} disabled={busy}>
				<FileText size={20} />
				<span className="artifact-file-name">{size ? `${file.filename}（${size}）` : file.filename}</span>
				{busy ? (
					<Loader2 size={15} className="spin artifact-file-open" />
				) : (
					<Download size={15} className="artifact-file-open" />
				)}
			</button>
			{error && <p className="artifact-frame-hint">{error}</p>}
		</div>
	);
}

function segmentKey(segment: ArtifactSegment): string {
	switch (segment.type) {
		case "text":
			return `text:${segment.content}`;
		case "images":
			return `images:${segment.artifacts.map((a) => a.url).join("|")}`;
		case "artifact":
			return `artifact:${segment.artifact.url}`;
		case "delivered_file":
			return `delivered:${segment.file.file_id}`;
	}
}

function ArtifactBlock({ segment }: { segment: ArtifactSegment }) {
	switch (segment.type) {
		case "text":
			return (
				<div className="artifact-caption">
					<MarkdownRenderer text={segment.content} />
				</div>
			);
		case "images":
			return <ImageGallery images={segment.artifacts} />;
		case "artifact":
			switch (segment.artifact.kind) {
				case "image":
					return <ImageGallery images={[segment.artifact]} />;
				case "video":
					return <VideoArtifact artifact={segment.artifact} />;
				case "app":
					return <WebFrame artifact={segment.artifact} />;
				case "file":
					return (
						<div className="artifact-files">
							<FileCard artifact={segment.artifact} />
						</div>
					);
				default:
					return null;
			}
		case "delivered_file":
			return <DeliveredFileCard file={segment.file} />;
	}
}

function MarkdownResult({ text }: { text: string }) {
	return (
		<div className="run-result-text">
			<MarkdownRenderer text={text} />
		</div>
	);
}

export default function ArtifactView({ segments, fallbackMarkdown }: ArtifactViewProps) {
	const hasArtifacts = segments.some((segment) => segment.type !== "text");
	const useInlineMarkdown = Boolean(fallbackMarkdown) && (!hasArtifacts || preferInlineMarkdownPreview(segments));

	if (useInlineMarkdown) {
		return <MarkdownResult text={fallbackMarkdown} />;
	}

	if (!hasArtifacts) {
		return fallbackMarkdown ? (
			<MarkdownResult text={fallbackMarkdown} />
		) : (
			<div className="run-result-text">
				<p>任务已完成，可在右侧查看完整运行事件。</p>
			</div>
		);
	}

	const imagesOnly =
		segments.length > 0 &&
		segments.every(
			(segment) => segment.type === "images" || (segment.type === "artifact" && segment.artifact.kind === "image"),
		);

	return (
		<div className={`artifact-view${imagesOnly ? " artifact-view--fill" : ""}`}>
			{segments.map((segment) => (
				<ArtifactBlock key={segmentKey(segment)} segment={segment} />
			))}
		</div>
	);
}

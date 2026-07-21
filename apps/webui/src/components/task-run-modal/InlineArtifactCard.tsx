import { Code, Download, ExternalLink, FileText, Loader2, Play } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { useArtifactAccess } from "@/lib/artifact-access-context";
import { artifactDisplayName } from "@/lib/artifact-file-name";
import { getFileDownloadUrl } from "@/lib/domain/file-api";
import { openHtmlArtifactInNewWindow } from "@/lib/hooks/useHtmlArtifactPreview";
import type { Artifact, ArtifactSegment, DeliveredFile, DocumentSegment } from "@/lib/view/artifact";
import { documentTypeLabel, resolveDocumentContent } from "@/lib/view/artifact";
import { Lightbox } from "../Lightbox";

function formatBytes(bytes?: number): string {
	if (!bytes || bytes < 1) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 内部子组件
// ---------------------------------------------------------------------------

function InlineImageCard({ artifact, onPreview }: { artifact: Artifact; onPreview: () => void }) {
	const access = useArtifactAccess();
	const expired = access?.isUrlExpired(artifact.url) ?? false;
	const name = artifactDisplayName(artifact.url, artifact.title);

	if (expired) {
		return (
			<button
				type="button"
				className="inline-artifact-card inline-artifact-expired"
				onClick={() => access?.promptRegenerate(artifact.url, name)}
			>
				<span className="inline-artifact-expired-badge">已过期</span>
				<span className="inline-artifact-expired-hint">点击重新生成</span>
			</button>
		);
	}

	return (
		<button type="button" className="inline-artifact-img-wrap" onClick={onPreview}>
			<img className="inline-artifact-img" src={artifact.url} alt={artifact.title ?? "产物"} loading="lazy" />
		</button>
	);
}

function InlineVideoCard({ artifact, onPreview }: { artifact: Artifact; onPreview: () => void }) {
	const access = useArtifactAccess();
	const expired = access?.isUrlExpired(artifact.url) ?? false;
	const name = artifactDisplayName(artifact.url, artifact.title);

	if (expired) {
		return (
			<button
				type="button"
				className="inline-artifact-card inline-artifact-expired"
				onClick={() => access?.promptRegenerate(artifact.url, name)}
			>
				<span className="inline-artifact-expired-badge">已过期</span>
				<span className="inline-artifact-expired-hint">点击重新生成</span>
			</button>
		);
	}

	return (
		<button type="button" className="inline-artifact-video-wrap" onClick={onPreview}>
			<Play size={28} className="inline-artifact-play" />
			<span className="inline-artifact-video-label">{name}</span>
		</button>
	);
}

function InlineAppCard({ artifact }: { artifact: Artifact }) {
	const access = useArtifactAccess();
	const name = artifactDisplayName(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;

	const onClick = (e: MouseEvent) => {
		e.preventDefault();
		if (expired) {
			access?.promptRegenerate(artifact.url, name);
		} else {
			access?.tryOpenUrl(artifact.url, name);
		}
	};

	return (
		<button type="button" className="inline-artifact-card" onClick={onClick}>
			<ExternalLink size={16} className="inline-artifact-icon" />
			<span className="inline-artifact-name">{name}</span>
			{expired && <span className="inline-artifact-expired-badge">已过期</span>}
		</button>
	);
}

function InlineFileCard({ artifact }: { artifact: Artifact }) {
	const access = useArtifactAccess();
	const name = artifactDisplayName(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;

	const onClick = (e: MouseEvent) => {
		e.preventDefault();
		if (expired) {
			access?.promptRegenerate(artifact.url, name);
		} else {
			access?.tryOpenUrl(artifact.url, name);
		}
	};

	return (
		<button type="button" className="inline-artifact-card" onClick={onClick}>
			<FileText size={16} className="inline-artifact-icon" />
			<span className="inline-artifact-name">{name}</span>
			{expired ? (
				<span className="inline-artifact-expired-badge">已过期</span>
			) : (
				<Download size={14} className="inline-artifact-action" />
			)}
		</button>
	);
}

function InlineDeliveredFileCard({ file }: { file: DeliveredFile }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const size = formatBytes(file.size);

	const onDownload = async (e: MouseEvent) => {
		e.preventDefault();
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
		<>
			<button type="button" className="inline-artifact-card" onClick={onDownload} disabled={busy}>
				<FileText size={16} className="inline-artifact-icon" />
				<span className="inline-artifact-name">{size ? `${file.filename}（${size}）` : file.filename}</span>
				{busy ? (
					<Loader2 size={14} className="spin inline-artifact-action" />
				) : (
					<Download size={14} className="inline-artifact-action" />
				)}
			</button>
			{error && <p className="inline-artifact-error">{error}</p>}
		</>
	);
}

function InlineDocumentCard({ segment }: { segment: DocumentSegment }) {
	const title = segment.title ?? documentTypeLabel(segment.mimeType);
	const srcDoc = resolveDocumentContent(segment);
	const openNew = (e: MouseEvent) => {
		e.preventDefault();
		void openHtmlArtifactInNewWindow("", srcDoc);
	};

	return (
		<div className="inline-document-card">
			<div className="inline-document-bar">
				<Code size={14} />
				<span className="inline-document-title">{title}</span>
				<button type="button" className="inline-document-btn" onClick={openNew}>
					<ExternalLink size={13} />
					新窗口
				</button>
			</div>
			<iframe className="inline-document-frame" srcDoc={srcDoc} title={title} sandbox="allow-scripts" />
		</div>
	);
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

interface InlineArtifactCardProps {
	segments: ArtifactSegment[];
}

/** 对话流中的 Artifact 内联卡片组 */
export function InlineArtifactCard({ segments }: InlineArtifactCardProps) {
	const [lightbox, setLightbox] = useState<{ type: "image" | "video"; url: string; title?: string } | null>(null);

	return (
		<div className="inline-artifact-group">
			{segments.map((segment) => {
				switch (segment.type) {
					case "images":
						return (
							<div key={`images:${segment.artifacts.map((a) => a.url).join("|")}`} className="inline-artifact-images">
								{segment.artifacts.map((img) => (
									<InlineImageCard
										key={img.url}
										artifact={img}
										onPreview={() => setLightbox({ type: "image", url: img.url, title: img.title })}
									/>
								))}
							</div>
						);
					case "artifact":
						switch (segment.artifact.kind) {
							case "image":
								return (
									<InlineImageCard
										key={segment.artifact.url}
										artifact={segment.artifact}
										onPreview={() =>
											setLightbox({ type: "image", url: segment.artifact.url, title: segment.artifact.title })
										}
									/>
								);
							case "video":
								return (
									<InlineVideoCard
										key={segment.artifact.url}
										artifact={segment.artifact}
										onPreview={() =>
											setLightbox({ type: "video", url: segment.artifact.url, title: segment.artifact.title })
										}
									/>
								);
							case "app":
								return <InlineAppCard key={segment.artifact.url} artifact={segment.artifact} />;
							case "file":
								return <InlineFileCard key={segment.artifact.url} artifact={segment.artifact} />;
							default:
								return null;
						}
					case "delivered_file":
						return <InlineDeliveredFileCard key={segment.file.file_id} file={segment.file} />;
					case "document":
						return (
							<InlineDocumentCard key={`doc:${segment.mimeType}:${segment.content.slice(0, 64)}`} segment={segment} />
						);
					case "text":
						// 纯文本已在 assistant 消息气泡中渲染，不再重复
						return null;
					default:
						return null;
				}
			})}

			{lightbox && (
				<Lightbox type={lightbox.type} url={lightbox.url} title={lightbox.title} onClose={() => setLightbox(null)} />
			)}
		</div>
	);
}

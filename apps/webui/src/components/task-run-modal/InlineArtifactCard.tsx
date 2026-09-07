import { Code, Download, ExternalLink, Eye, Loader2, Play } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { useArtifactAccess } from "@/lib/artifact-access-context";
import { artifactDisplayName } from "@/lib/artifact-file-name";
import { openHtmlArtifactInNewWindow } from "@/lib/hooks/useHtmlArtifactPreview";
import type { Artifact, ArtifactSegment, DeliveredFile, DocumentSegment } from "@/lib/view/artifact";
import { documentTypeLabel, resolveDocumentContent } from "@/lib/view/artifact";
import { Lightbox } from "../Lightbox";

const HTML_PRODUCT_ICON_URL =
	"https://img.alicdn.com/imgextra/i3/O1CN013vvHTH1zKpDGKhUYI_!!6000000006696-55-tps-16-16.svg";
const FILE_PRODUCT_ICON_URL =
	"https://img.alicdn.com/imgextra/i4/O1CN01FRZSwM24WLFdmAfCY_!!6000000007398-55-tps-16-16.svg";

function formatBytes(bytes?: number): string {
	if (!bytes || bytes < 1) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function productTitle(url: string, title?: string | null): string {
	const raw = artifactDisplayName(url, title);
	return raw.replace(/^下载\s*[:：]?\s*/u, "").trim() || artifactDisplayName(url);
}

function formatCreatedLabel(iso?: string): string | undefined {
	if (!iso) return undefined;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return undefined;
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `创建于${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${hours}:${minutes}`;
}

function isProductSegment(segment: ArtifactSegment): boolean {
	if (segment.type === "delivered_file") return true;
	if (segment.type !== "artifact") return false;
	return segment.artifact.kind === "file" || segment.artifact.kind === "app";
}

function canPreviewDeliveredFile(file: DeliveredFile): boolean {
	return (
		/(?:text\/html|image\/svg\+xml|text\/markdown)/i.test(file.content_type ?? "") ||
		/\.(?:html?|svg|md)(?:[?#]|$)/i.test(file.filename)
	);
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

function ProductFileCard({
	title,
	createdAt,
	icon,
	canPreview,
	expired,
	busy,
	error,
	onDownload,
	onPreview,
}: {
	title: string;
	createdAt?: string;
	icon: "web" | "file";
	canPreview: boolean;
	expired?: boolean;
	busy?: boolean;
	error?: string | null;
	onDownload(): void;
	onPreview?: () => void;
}) {
	const createdLabel = formatCreatedLabel(createdAt);
	return (
		<div className={`inline-product-card${expired ? " expired" : ""}`}>
			<div className="inline-product-left">
				<div className="inline-product-head">
					<img
						className="inline-product-icon"
						src={icon === "web" ? HTML_PRODUCT_ICON_URL : FILE_PRODUCT_ICON_URL}
						alt=""
					/>
					<div className="inline-product-title" title={title}>
						{title}
					</div>
				</div>
				{createdLabel ? <div className="inline-product-time">{createdLabel}</div> : null}
			</div>
			<div className="inline-product-actions">
				{expired ? (
					<button type="button" className="inline-product-action" onClick={onDownload}>
						<span className="inline-artifact-expired-badge">已过期</span>
					</button>
				) : (
					<>
						<button type="button" className="inline-product-action" onClick={onDownload} disabled={busy}>
							{busy ? <Loader2 className="spin" /> : <Download />}
							<span>下载</span>
						</button>
						{canPreview && onPreview ? (
							<button type="button" className="inline-product-action" onClick={onPreview} disabled={busy}>
								<Eye />
								<span>预览</span>
							</button>
						) : null}
					</>
				)}
			</div>
			{error ? <p className="inline-artifact-error">{error}</p> : null}
		</div>
	);
}

function InlineUrlProductCard({ artifact, createdAt }: { artifact: Artifact; createdAt?: string }) {
	const access = useArtifactAccess();
	const title = productTitle(artifact.url, artifact.title);
	const expired = access?.isUrlExpired(artifact.url) ?? false;

	const onDownload = () => {
		if (expired) {
			access?.promptRegenerate(artifact.url, title);
		} else {
			access?.tryOpenUrl(artifact.url, title);
		}
	};
	const onPreview = () => {
		if (expired) return access?.promptRegenerate(artifact.url, title);
		void openHtmlArtifactInNewWindow(artifact.url);
	};

	return (
		<ProductFileCard
			title={title}
			createdAt={createdAt}
			icon={artifact.kind === "app" ? "web" : "file"}
			canPreview={artifact.kind === "app"}
			expired={expired}
			onDownload={onDownload}
			onPreview={artifact.kind === "app" ? onPreview : undefined}
		/>
	);
}

function InlineDeliveredProductCard({ file, createdAt }: { file: DeliveredFile; createdAt?: string }) {
	const access = useArtifactAccess();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const size = formatBytes(file.size);
	const title = size ? `${file.filename}（${size}）` : file.filename;

	const resolveUrl = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			if (!access?.resolveDeliveredFile) throw new Error("当前页面不支持下载此产物");
			return await access.resolveDeliveredFile(file.file_id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "下载失败");
			return undefined;
		} finally {
			setBusy(false);
		}
	};
	const onDownload = async () => {
		const url = await resolveUrl();
		if (url) window.open(url, "_blank", "noopener,noreferrer");
	};
	const onPreview = async () => {
		const url = await resolveUrl();
		if (url) void openHtmlArtifactInNewWindow(url);
	};

	return (
		<ProductFileCard
			title={title}
			createdAt={createdAt}
			icon={canPreviewDeliveredFile(file) ? "web" : "file"}
			canPreview={canPreviewDeliveredFile(file)}
			busy={busy}
			error={error}
			onDownload={() => void onDownload()}
			onPreview={canPreviewDeliveredFile(file) ? () => void onPreview() : undefined}
		/>
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
	createdAt?: string;
}

/** 对话流中的 Artifact 内联卡片组 */
export function InlineArtifactCard({ segments, createdAt }: InlineArtifactCardProps) {
	const [lightbox, setLightbox] = useState<{ type: "image" | "video"; url: string; title?: string } | null>(null);
	const productSegments = segments.filter(isProductSegment);
	const mediaSegments = segments.filter((segment) => !isProductSegment(segment));

	return (
		<div className="inline-artifact-group">
			{productSegments.length > 0 ? (
				<div className="inline-product-block">
					<div className="inline-product-label">任务完成</div>
					<div className="inline-product-list">
						{productSegments.map((segment) => {
							if (segment.type === "delivered_file") {
								return (
									<InlineDeliveredProductCard key={segment.file.file_id} file={segment.file} createdAt={createdAt} />
								);
							}
							if (segment.type === "artifact") {
								return (
									<InlineUrlProductCard key={segment.artifact.url} artifact={segment.artifact} createdAt={createdAt} />
								);
							}
							return null;
						})}
					</div>
				</div>
			) : null}

			{mediaSegments.map((segment) => {
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
							case "file":
								return null;
							default:
								return null;
						}
					case "delivered_file":
						return null;
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

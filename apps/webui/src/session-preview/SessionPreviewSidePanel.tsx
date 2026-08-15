import { Bot, Download, ExternalLink, FileText, Image, Loader2, Server, Sparkles, Video, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionDetail } from "@/lib/project-api";
import type { RunTimelineItem } from "@/lib/view/run-timeline";
import {
	buildPreviewArtifacts,
	buildPreviewCapabilities,
	type PreviewArtifactEntry,
	type PreviewCapabilityEntry,
	previewAgentModel,
} from "./sidebar-data";

interface SessionPreviewSidePanelProps {
	detail: SessionDetail;
	timelineItems: RunTimelineItem[];
	onLocate(timelineKey: string): void;
	onResolveDeliveredFile(fileId: string): Promise<string>;
}

export function SessionPreviewSidePanel({
	detail,
	timelineItems,
	onLocate,
	onResolveDeliveredFile,
}: SessionPreviewSidePanelProps) {
	const artifacts = useMemo(() => buildPreviewArtifacts(timelineItems), [timelineItems]);
	const capabilities = useMemo(
		() => buildPreviewCapabilities(detail.agent_details, timelineItems),
		[detail.agent_details, timelineItems],
	);
	const tools = capabilities.filter((capability) => capability.kind === "tool");
	const cards = capabilities.filter((capability) => capability.kind !== "tool");
	const model = previewAgentModel(detail.agent_details);

	return (
		<aside className="session-preview-side-panel" aria-label="Session 详情侧栏">
			<section className="session-preview-side-section">
				<h2>智能体</h2>
				<div className="session-preview-agent-card">
					<div className="session-preview-agent-card-head">
						<span className="session-preview-side-avatar">
							{detail.agent_name.trim().slice(0, 1).toUpperCase() || <Bot />}
						</span>
						<div>
							<strong>{detail.agent_name}</strong>
							<span>{detail.agent_id}</span>
						</div>
					</div>
					{detail.agent_details.description && <p>{detail.agent_details.description}</p>}
					<div className="session-preview-agent-meta">
						<span>{detail.provider}</span>
						{model && <span title={model}>{model}</span>}
					</div>
				</div>
			</section>

			<section className="session-preview-side-section">
				<div className="session-preview-side-heading">
					<h2>产出的文件</h2>
					{artifacts.length > 0 && <span>{artifacts.length}</span>}
				</div>
				{artifacts.length === 0 ? (
					<p className="session-preview-side-empty">暂无产出文件</p>
				) : (
					<ul className="session-preview-file-list">
						{artifacts.map((artifact) => (
							<ArtifactRow
								key={artifact.id}
								artifact={artifact}
								onLocate={onLocate}
								onResolveDeliveredFile={onResolveDeliveredFile}
							/>
						))}
					</ul>
				)}
			</section>

			<section className="session-preview-side-section session-preview-side-section-grow">
				<h2>调用的能力</h2>
				<ul className="session-preview-capability-list">
					<li className="session-preview-capability-card tools">
						<div className="session-preview-capability-head">
							<span className="session-preview-capability-icon tool">
								<Wrench />
							</span>
							<strong>工具</strong>
						</div>
						{tools.length === 0 ? (
							<p>暂无工具</p>
						) : (
							<div className="session-preview-tool-tags">
								{tools.map((tool) => (
									<button
										type="button"
										key={tool.id}
										disabled={!tool.timelineKey}
										onClick={() => tool.timelineKey && onLocate(tool.timelineKey)}
									>
										{tool.name}
										{tool.count > 0 && <small>{tool.count}</small>}
									</button>
								))}
							</div>
						)}
					</li>
					{cards.map((capability) => (
						<CapabilityCard key={capability.id} capability={capability} onLocate={onLocate} />
					))}
				</ul>
			</section>
		</aside>
	);
}

function ArtifactRow({
	artifact,
	onLocate,
	onResolveDeliveredFile,
}: {
	artifact: PreviewArtifactEntry;
	onLocate(timelineKey: string): void;
	onResolveDeliveredFile(fileId: string): Promise<string>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const canOpen = Boolean(artifact.url || artifact.fileId);
	const open = async () => {
		if (busy || !canOpen) return;
		setBusy(true);
		setError(undefined);
		let popup: Window | null = null;
		try {
			if (artifact.fileId) popup = window.open("about:blank", "_blank");
			const url = artifact.url ?? (artifact.fileId ? await onResolveDeliveredFile(artifact.fileId) : undefined);
			if (!url) return;
			if (popup) popup.location.assign(url);
			else window.open(url, "_blank", "noopener,noreferrer");
		} catch (openError) {
			popup?.close();
			setError(openError instanceof Error ? openError.message : String(openError));
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="session-preview-file-card">
			<button type="button" className="session-preview-file-locate" onClick={() => onLocate(artifact.timelineKey)}>
				<span className="session-preview-file-icon">{artifactIcon(artifact)}</span>
				<span className="session-preview-file-copy">
					<strong title={artifact.title}>{artifact.title}</strong>
					<small>{artifactKindLabel(artifact)}</small>
				</span>
			</button>
			{canOpen && (
				<button
					type="button"
					className="session-preview-file-open"
					disabled={busy}
					onClick={() => void open()}
					aria-label={`打开 ${artifact.title}`}
				>
					{busy ? <Loader2 className="spin" /> : artifact.fileId ? <Download /> : <ExternalLink />}
				</button>
			)}
			{error && <p>{error}</p>}
		</li>
	);
}

function CapabilityCard({
	capability,
	onLocate,
}: {
	capability: PreviewCapabilityEntry;
	onLocate(timelineKey: string): void;
}) {
	return (
		<li>
			<button
				type="button"
				className="session-preview-capability-card"
				disabled={!capability.timelineKey}
				onClick={() => capability.timelineKey && onLocate(capability.timelineKey)}
			>
				<span className={`session-preview-capability-icon ${capability.kind}`}>
					{capability.kind === "mcp" ? <Server /> : <Sparkles />}
				</span>
				<span className="session-preview-capability-copy">
					<strong title={capability.name}>{capability.name}</strong>
					<small>
						{capability.kind === "mcp" ? "MCP" : "Skill"}
						{capability.version ? ` · ${capability.version}` : ""}
					</small>
				</span>
				<span className={capability.count > 0 ? "used" : "configured"}>
					{capability.count > 0 ? `${capability.count} 次` : "已配置"}
				</span>
			</button>
		</li>
	);
}

function artifactIcon(artifact: PreviewArtifactEntry) {
	if (artifact.kind === "image") return <Image />;
	if (artifact.kind === "video") return <Video />;
	return <FileText />;
}

function artifactKindLabel(artifact: PreviewArtifactEntry): string {
	if (artifact.kind === "delivered_file") return "文件";
	if (artifact.kind === "document") {
		if (artifact.mimeType === "image/svg+xml") return "SVG";
		if (artifact.mimeType === "text/mermaid") return "Mermaid";
		return "HTML";
	}
	if (artifact.kind === "app") return "网页";
	if (artifact.kind === "image") return "图片";
	if (artifact.kind === "video") return "视频";
	return "文件";
}

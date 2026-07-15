import { Eye, Video, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { createPortal } from "react-dom";
import { getShowcasePreviewItems, type ShowcaseMedia, type ShowcaseMediaThumb } from "@/lib/showcase-types";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";

interface CaseDetailModalProps {
	open: boolean;
	onClose: () => void;
	playbookName: string;
	prompt: string;
	agentId?: string;
	imageId: number;
	media: ShowcaseMedia;
	onMakeSame: (input: { prompt: string; agentId?: string }) => void;
}

// Mock agent conversation
const mockConversation = [
	{
		id: "user-prompt",
		role: "user" as const,
		content: "",
	},
	{
		id: "agent-plan",
		role: "agent" as const,
		content:
			"好的，我来帮你完成这个任务。让我分析一下需求...\n\n**Step 1: 需求分析**\n识别核心目标，确定输出格式和风格要求。\n\n**Step 2: 生成方案**\n根据需求选择合适的模型和参数配置。\n\n**Step 3: 执行生成**\n调用模型完成内容生成，并对结果进行质量检查。",
	},
	{
		id: "agent-done",
		role: "agent" as const,
		content: "任务已完成！以下是生成的结果，你可以在左侧预览区域查看。如需调整请告诉我。",
	},
];

function PreviewItem({ item }: { item: ShowcaseMediaThumb }) {
	if (item.type === "video") {
		return (
			<video
				key={item.url}
				className="case-result-video"
				src={item.url}
				poster={item.poster}
				controls
				playsInline
				preload="metadata"
			>
				<track kind="captions" />
				您的浏览器不支持视频播放。
			</video>
		);
	}

	return <img key={item.url} src={item.url} alt="案例产物" className="case-result-img" />;
}

function Thumb({ item, index }: { item: ShowcaseMediaThumb; index: number }) {
	if (item.type === "video") {
		return (
			<div className="case-thumb-video">
				{item.poster ? <img src={item.poster} alt={`缩略图${index + 1}`} /> : <Video size={18} />}
			</div>
		);
	}

	return <img src={item.url} alt={`缩略图${index + 1}`} />;
}

export default function CaseDetailModal({
	open,
	onClose,
	playbookName,
	prompt,
	agentId,
	imageId,
	media,
	onMakeSame,
}: CaseDetailModalProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const previewItems = getShowcasePreviewItems(media);
	const activeItem = previewItems[selectedIndex] ?? previewItems[0];

	useBodyScrollLock(open);

	// ESC to close
	const onEscClose = useEffectEvent(() => onClose());
	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onEscClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open]);

	if (!open || !activeItem) return null;

	const conversation = [{ ...mockConversation[0], content: prompt }, ...mockConversation.slice(1)];

	return createPortal(
		<div className="case-modal-overlay">
			<div className="case-modal">
				<button className="case-modal-close" onClick={onClose} type="button">
					<X size={20} />
				</button>

				<div className="case-modal-header">
					<h2 className="case-modal-title">{playbookName}</h2>
					<div className="case-modal-actions">
						<button
							className="case-modal-btn primary"
							type="button"
							onClick={() => {
								onMakeSame({ prompt, agentId });
								onClose();
							}}
						>
							做同款
						</button>
					</div>
				</div>

				<div className="case-modal-body">
					<div className="case-modal-result">
						<div className="case-result-main">
							<PreviewItem item={activeItem} />
						</div>
						{previewItems.length > 1 && (
							<div className="case-result-thumbs">
								{previewItems.map((item, index) => (
									<button
										key={item.url}
										type="button"
										className={`case-thumb ${index === selectedIndex ? "active" : ""}`}
										onClick={() => setSelectedIndex(index)}
										aria-label={`预览 ${index + 1}`}
									>
										<Thumb item={item} index={index} />
									</button>
								))}
							</div>
						)}
					</div>

					<div className="case-modal-chat">
						<div className="case-chat-user">
							<div className="case-chat-avatar">
								<img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${imageId}`} alt="用户" />
							</div>
							<span className="case-chat-username">创作者</span>
							<div className="case-chat-stats">
								<span>
									<Eye size={13} /> 6.2k
								</span>
							</div>
						</div>

						<div className="case-chat-messages">
							{conversation.map((msg) => (
								<div key={msg.id} className={`case-msg ${msg.role}`}>
									<div className="case-msg-bubble">
										{msg.content.split("\n").map((line, j) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no stable id; order is fixed
											<p key={j}>{line || <br />}</p>
										))}
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

interface LightboxProps {
	type: "image" | "video";
	url: string;
	title?: string;
	onClose: () => void;
}

/** 图片/视频全屏预览浮层 */
export function Lightbox({ type, url, title, onClose }: LightboxProps) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", handler, true);
		return () => document.removeEventListener("keydown", handler, true);
	}, [onClose]);

	return createPortal(
		<div className="lightbox-overlay">
			<button className="lightbox-backdrop" onClick={onClose} type="button" aria-label="关闭预览" />
			<button className="lightbox-close" onClick={onClose} type="button" aria-label="关闭预览">
				<X size={20} />
			</button>
			<div className="lightbox-content">
				{type === "image" ? (
					<img className="lightbox-img" src={url} alt={title ?? "预览"} />
				) : (
					<video className="lightbox-video" src={url} controls autoPlay playsInline>
						<track kind="captions" />
						您的浏览器不支持视频播放。
					</video>
				)}
			</div>
		</div>,
		document.body,
	);
}

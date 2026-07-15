import { Play } from "lucide-react";
import { useCallback, useState } from "react";
import { getShowcaseCoverUrl, type ShowcaseMedia } from "@/lib/showcase-types";

interface MasonryCardProps {
	category: string;
	height: number;
	playbookName: string;
	prompt: string;
	agentId?: string;
	imageId: number;
	media?: ShowcaseMedia;
	hidden?: boolean;
	onMakeSame: (input: { prompt: string; agentId?: string }) => void;
	onCardClick: () => void;
}

export default function MasonryCard({
	category,
	height,
	playbookName,
	prompt,
	agentId,
	media,
	hidden,
	onMakeSame,
	onCardClick,
}: MasonryCardProps) {
	const [loaded, setLoaded] = useState(false);
	const coverUrl = getShowcaseCoverUrl(media);
	const isVideo = media?.type === "video";

	// Catch images already complete (cached) the moment the node attaches — onLoad may have fired
	// before the handler was wired. Runs on commit, not as a mount effect.
	const imgRef = useCallback((node: HTMLImageElement | null) => {
		if (node?.complete && node.naturalWidth > 0) setLoaded(true);
	}, []);

	return (
		<div className={`masonry-item ${hidden ? "hidden" : ""}`} data-category={category}>
			<button type="button" className="masonry-card-btn" aria-label={playbookName} onClick={onCardClick}>
				<div className="masonry-img-wrap" style={{ height: `${height}px` }}>
					<div className={`skeleton-placeholder ${loaded ? "hide" : ""}`} />
					<img
						ref={imgRef}
						src={coverUrl}
						alt={playbookName}
						loading="lazy"
						className={loaded ? "loaded" : ""}
						onLoad={() => setLoaded(true)}
						onError={() => setLoaded(true)}
					/>
					{isVideo && (
						<div className="masonry-video-badge" aria-hidden>
							<Play size={16} />
						</div>
					)}
				</div>
				<div className="masonry-overlay">
					<span className="masonry-playbook-name">{playbookName}</span>
				</div>
			</button>
			<button
				type="button"
				className="masonry-hover-btn"
				onClick={(e) => {
					e.stopPropagation();
					onMakeSame({ prompt, agentId });
				}}
			>
				做同款
			</button>
		</div>
	);
}

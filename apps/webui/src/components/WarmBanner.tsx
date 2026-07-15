import { useState } from "react";
import type { WarmProgress } from "@/lib/domain/warm";

// Non-blocking top banner shown while app-entry warming runs. Reports N/M warm tasks (base resources
// + distinct skills) prepared and lets the user collapse it; the rest of the page stays fully usable.
// Renders nothing once warming
// is done (or before it starts), so success is invisible — only a cold workspace ever shows it.
export default function WarmBanner({ progress }: { progress: WarmProgress | null }) {
	const [collapsed, setCollapsed] = useState(false);
	if (!progress || progress.total === 0 || progress.done >= progress.total || collapsed) return null;
	return (
		<output className="warm-banner" aria-live="polite">
			<span className="warm-banner-spinner" aria-hidden="true" />
			<span className="warm-banner-text">
				正在准备工作区… {progress.done}/{progress.total}
			</span>
			<button type="button" className="warm-banner-collapse" onClick={() => setCollapsed(true)}>
				收起
			</button>
		</output>
	);
}

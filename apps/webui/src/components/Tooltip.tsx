import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Lightweight hover tooltip. The trigger is rendered inline (carrying `className`, so callers can
// apply ellipsis truncation to it); the bubble is portalled to document.body and positioned with
// position:fixed so it escapes any scroll container's overflow clipping (the resource-center tables
// are overflow:auto and would otherwise clip an in-flow tooltip). The bubble only appears when the
// trigger's content is actually clipped, so short text gets no redundant tooltip.
export default function Tooltip({
	text,
	className,
	children,
}: {
	text?: string;
	className?: string;
	children: ReactNode;
}) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

	const show = () => {
		const el = triggerRef.current;
		if (!el || !text) return;
		if (el.scrollWidth <= el.clientWidth) return;
		const r = el.getBoundingClientRect();
		setCoords({ left: r.left + r.width / 2, top: r.top });
	};
	const hide = () => setCoords(null);

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only reveal for a presentational overflow tooltip; the full text is in the DOM for assistive tech, so the trigger needs no focus/role. */}
			<span ref={triggerRef} className={className} onMouseEnter={show} onMouseLeave={hide}>
				{children}
			</span>
			{coords
				? createPortal(
						<div className="rc-tooltip" role="tooltip" style={{ left: coords.left, top: coords.top }}>
							{text}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

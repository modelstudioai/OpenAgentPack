import { useEffect } from "react";

let lockCount = 0;
let savedScrollY = 0;

function lockBodyScroll(): void {
	lockCount += 1;
	if (lockCount > 1) return;

	savedScrollY = window.scrollY;
	document.documentElement.style.overflow = "hidden";
	document.body.style.overflow = "hidden";
	document.body.style.position = "fixed";
	document.body.style.top = `-${savedScrollY}px`;
	document.body.style.width = "100%";
}

function unlockBodyScroll(): void {
	lockCount = Math.max(0, lockCount - 1);
	if (lockCount > 0) return;

	document.documentElement.style.overflow = "";
	document.body.style.overflow = "";
	document.body.style.position = "";
	document.body.style.top = "";
	document.body.style.width = "";
	window.scrollTo(0, savedScrollY);
}

/** Prevent background page scroll while a modal overlay is open. Ref-counted for nested modals. */
export function useBodyScrollLock(locked: boolean): void {
	useEffect(() => {
		if (!locked) return undefined;
		lockBodyScroll();
		return () => unlockBodyScroll();
	}, [locked]);
}

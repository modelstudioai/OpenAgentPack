import { useCallback, useEffect, useState } from "react";
import { type TopBarView, urlForView, viewFromPathname } from "@/lib/topbar-route";

export function useTopBarView(): [TopBarView, (view: TopBarView) => void] {
	const [view, setView] = useState<TopBarView>(() => viewFromPathname(window.location.pathname));

	useEffect(() => {
		const syncFromUrl = () => setView(viewFromPathname(window.location.pathname));
		window.addEventListener("popstate", syncFromUrl);
		return () => window.removeEventListener("popstate", syncFromUrl);
	}, []);

	const navigate = useCallback((next: TopBarView) => {
		const nextUrl = urlForView(next, window.location);
		const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		if (nextUrl !== currentUrl) {
			history.pushState(null, "", nextUrl);
		}
		setView(next);
	}, []);

	return [view, navigate];
}

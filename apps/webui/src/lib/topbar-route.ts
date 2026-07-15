export type TopBarView = "home" | "resources";

const RESOURCES_SUFFIX = "/resources";

export function viewFromPathname(pathname: string): TopBarView {
	const normalized = pathname.replace(/\/$/, "") || "/";
	if (normalized === RESOURCES_SUFFIX || normalized.endsWith(RESOURCES_SUFFIX)) {
		return "resources";
	}
	return "home";
}

export function pathnameForView(view: TopBarView, pathname: string): string {
	const normalized = pathname.replace(/\/$/, "") || "/";
	const onResources = viewFromPathname(normalized) === "resources";

	if (view === "resources") {
		if (onResources) return pathname;
		if (normalized === "/") return RESOURCES_SUFFIX;
		return `${normalized}${RESOURCES_SUFFIX}`;
	}

	if (!onResources) return pathname;
	if (normalized === RESOURCES_SUFFIX) return "/";
	return normalized.slice(0, -RESOURCES_SUFFIX.length) || "/";
}

export function urlForView(view: TopBarView, location: Pick<Location, "pathname" | "search" | "hash">): string {
	return `${pathnameForView(view, location.pathname)}${location.search}${location.hash}`;
}

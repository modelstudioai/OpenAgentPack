export type TopBarView = "home" | "resources" | "deployments";

const RESOURCES_SUFFIX = "/resources";
const DEPLOYMENTS_SUFFIX = "/deployments";

export function viewFromPathname(pathname: string): TopBarView {
	const normalized = pathname.replace(/\/$/, "") || "/";
	if (normalized === DEPLOYMENTS_SUFFIX || normalized.endsWith(DEPLOYMENTS_SUFFIX)) {
		return "deployments";
	}
	if (normalized === RESOURCES_SUFFIX || normalized.endsWith(RESOURCES_SUFFIX)) {
		return "resources";
	}
	return "home";
}

export function pathnameForView(view: TopBarView, pathname: string): string {
	const normalized = pathname.replace(/\/$/, "") || "/";
	const currentView = viewFromPathname(normalized);

	if (view === "deployments") {
		if (currentView === "deployments") return pathname;
		if (normalized === "/") return DEPLOYMENTS_SUFFIX;
		if (currentView === "resources")
			return `${normalized.slice(0, -RESOURCES_SUFFIX.length) || "/"}${DEPLOYMENTS_SUFFIX}`;
		return `${normalized}${DEPLOYMENTS_SUFFIX}`;
	}

	if (view === "resources") {
		if (currentView === "resources") return pathname;
		if (normalized === "/") return RESOURCES_SUFFIX;
		if (currentView === "deployments")
			return `${normalized.slice(0, -DEPLOYMENTS_SUFFIX.length) || "/"}${RESOURCES_SUFFIX}`;
		return `${normalized}${RESOURCES_SUFFIX}`;
	}

	if (currentView === "home") return pathname;
	if (normalized === RESOURCES_SUFFIX) return "/";
	if (normalized === DEPLOYMENTS_SUFFIX) return "/";
	if (currentView === "deployments") return normalized.slice(0, -DEPLOYMENTS_SUFFIX.length) || "/";
	return normalized.slice(0, -RESOURCES_SUFFIX.length) || "/";
}

export function urlForView(view: TopBarView, location: Pick<Location, "pathname" | "search" | "hash">): string {
	return `${pathnameForView(view, location.pathname)}${location.search}${location.hash}`;
}

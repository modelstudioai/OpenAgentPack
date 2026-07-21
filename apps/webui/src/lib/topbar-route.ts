export type TopBarView = "home" | "resources" | "schedule";

const RESOURCES_SUFFIX = "/resources";
const SCHEDULE_SUFFIX = "/schedule";

export function viewFromPathname(pathname: string): TopBarView {
	const normalized = pathname.replace(/\/$/, "") || "/";
	if (normalized === SCHEDULE_SUFFIX || normalized.endsWith(SCHEDULE_SUFFIX)) {
		return "schedule";
	}
	if (normalized === RESOURCES_SUFFIX || normalized.endsWith(RESOURCES_SUFFIX)) {
		return "resources";
	}
	return "home";
}

export function pathnameForView(view: TopBarView, pathname: string): string {
	const normalized = pathname.replace(/\/$/, "") || "/";
	const currentView = viewFromPathname(normalized);

	if (view === "schedule") {
		if (currentView === "schedule") return pathname;
		if (normalized === "/") return SCHEDULE_SUFFIX;
		if (currentView === "resources") return `${normalized.slice(0, -RESOURCES_SUFFIX.length) || "/"}${SCHEDULE_SUFFIX}`;
		return `${normalized}${SCHEDULE_SUFFIX}`;
	}

	if (view === "resources") {
		if (currentView === "resources") return pathname;
		if (normalized === "/") return RESOURCES_SUFFIX;
		if (currentView === "schedule") return `${normalized.slice(0, -SCHEDULE_SUFFIX.length) || "/"}${RESOURCES_SUFFIX}`;
		return `${normalized}${RESOURCES_SUFFIX}`;
	}

	if (currentView === "home") return pathname;
	if (normalized === RESOURCES_SUFFIX) return "/";
	if (normalized === SCHEDULE_SUFFIX) return "/";
	if (currentView === "schedule") return normalized.slice(0, -SCHEDULE_SUFFIX.length) || "/";
	return normalized.slice(0, -RESOURCES_SUFFIX.length) || "/";
}

export function urlForView(view: TopBarView, location: Pick<Location, "pathname" | "search" | "hash">): string {
	return `${pathnameForView(view, location.pathname)}${location.search}${location.hash}`;
}

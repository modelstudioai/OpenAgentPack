type JsonObject = Record<string, unknown>;
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export function rewriteExportTargets(value: unknown, resolveExport: (sourceExport: string) => string): unknown {
	if (typeof value === "string") {
		return /^\.\/(?:src|bin)\//.test(value) ? resolveExport(value) : value;
	}
	if (Array.isArray(value)) return value.map((entry) => rewriteExportTargets(entry, resolveExport));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, rewriteExportTargets(entry, resolveExport)]),
		);
	}
	return value;
}

export function rewriteWorkspaceDependencies(
	manifest: JsonObject,
	workspaceVersions: ReadonlyMap<string, string>,
): void {
	for (const field of dependencyFields) {
		const dependencies = manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		const dependencyMap = dependencies as JsonObject;
		for (const [name, rawRange] of Object.entries(dependencyMap)) {
			if (typeof rawRange !== "string" || !rawRange.startsWith("workspace:")) continue;
			const version = workspaceVersions.get(name);
			if (!version) throw new Error(`Cannot publish ${name}: no workspace package version was found.`);
			const workspaceRange = rawRange.slice("workspace:".length);
			const prefix = workspaceRange === "^" || workspaceRange === "~" ? workspaceRange : "";
			dependencyMap[name] = `${prefix}${version}`;
		}
	}
}

function manifestTargets(manifest: JsonObject): string[] {
	const targets: string[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.startsWith("./")) targets.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (value && typeof value === "object") {
			for (const entry of Object.values(value)) visit(entry);
		}
	};
	for (const field of ["main", "module", "types", "bin", "exports"] as const) visit(manifest[field]);
	return [...new Set(targets)];
}

function targetIsPacked(target: string, files: unknown): boolean {
	if (!Array.isArray(files)) return true;
	const path = target.replace(/^\.\//, "");
	return files.some((entry) => typeof entry === "string" && (path === entry || path.startsWith(`${entry}/`)));
}

export function assertPublishManifest(
	manifest: JsonObject,
	targetExists: (target: string) => boolean,
	context: string,
): void {
	for (const field of dependencyFields) {
		const dependencies = manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const [name, range] of Object.entries(dependencies)) {
			if (typeof range === "string" && range.startsWith("workspace:")) {
				throw new Error(`Published manifest dependency '${name}' still uses '${range}' in ${context}.`);
			}
		}
	}
	for (const target of manifestTargets(manifest)) {
		if (!targetExists(target)) throw new Error(`Published manifest target '${target}' does not exist in ${context}.`);
		if (!targetIsPacked(target, manifest.files)) {
			throw new Error(`Published manifest target '${target}' is excluded by package.json files in ${context}.`);
		}
	}
}

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const webui = join(root, "apps/webui");

type PackageManifest = {
	name: string;
	version: string;
	license?: string;
	homepage?: string;
	repository?: string | { url?: string };
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

export type BundledLicense = {
	name: string;
	version: string;
	license: string;
	source?: string;
	texts: Array<{ filename: string; content: string }>;
};

function readManifest(packageRoot: string): PackageManifest {
	return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
}

function findPackageRoot(name: string, entry: string): string | undefined {
	let cursor = dirname(realpathSync(entry));
	for (;;) {
		const manifestPath = join(cursor, "package.json");
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
			if (manifest.name === name) return cursor;
		}
		const parent = dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
}

function resolvePackageRoot(name: string, from: string): string | undefined {
	const require = createRequire(join(from, "package.json"));
	try {
		return dirname(realpathSync(require.resolve(`${name}/package.json`)));
	} catch {
		try {
			return findPackageRoot(name, require.resolve(name));
		} catch {
			return undefined;
		}
	}
}

function sourceUrl(manifest: PackageManifest): string | undefined {
	const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
	return (repository ?? manifest.homepage)?.replace(/^git\+/, "").replace(/\.git$/, "");
}

function licenseTexts(packageRoot: string): Array<{ filename: string; content: string }> {
	return readdirSync(packageRoot)
		.filter((filename) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(filename))
		.sort()
		.map((filename) => ({ filename, content: readFileSync(join(packageRoot, filename), "utf8").trim() }));
}

export function collectWebBundleLicenses(): BundledLicense[] {
	const webManifest = readManifest(webui);
	const queue = Object.keys(webManifest.dependencies ?? {})
		.filter((name) => !name.startsWith("@openagentpack/"))
		.map((name) => ({ name, from: webui, optional: false }));
	const visited = new Set<string>();
	const licenses: BundledLicense[] = [];

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		const packageRoot = resolvePackageRoot(item.name, item.from);
		if (!packageRoot) {
			if (item.optional) continue;
			throw new Error(`Cannot resolve bundled dependency '${item.name}' from ${item.from}`);
		}
		const canonicalRoot = realpathSync(packageRoot);
		if (visited.has(canonicalRoot)) continue;
		visited.add(canonicalRoot);

		const manifest = readManifest(canonicalRoot);
		if (canonicalRoot.startsWith(`${root}${sep}`) && manifest.name.startsWith("@openagentpack/")) continue;
		const texts = licenseTexts(canonicalRoot);
		if (!manifest.license || texts.length === 0) {
			throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has incomplete license metadata`);
		}
		licenses.push({
			name: manifest.name,
			version: manifest.version,
			license: manifest.license,
			source: sourceUrl(manifest),
			texts,
		});

		for (const name of Object.keys(manifest.dependencies ?? {})) {
			queue.push({ name, from: canonicalRoot, optional: false });
		}
		for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
			queue.push({ name, from: canonicalRoot, optional: true });
		}
	}

	return licenses.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function renderWebBundleLicenses(licenses = collectWebBundleLicenses()): string {
	const sections = licenses.map((entry) => {
		const metadata = [`- License: ${entry.license}`, entry.source ? `- Source: ${entry.source}` : undefined]
			.filter(Boolean)
			.join("\n");
		const texts = entry.texts
			.map(({ filename, content }) => `### ${filename}\n\n\`\`\`text\n${content}\n\`\`\``)
			.join("\n\n");
		return `## ${entry.name}@${entry.version}\n\n${metadata}\n\n${texts}`;
	});
	return `# Bundled WebUI Third-Party Licenses\n\nThis inventory is generated from the production dependency closure bundled into the OpenAgentPack Playground WebUI.\n\n${sections.join("\n\n")}\n`;
}

if (import.meta.main) process.stdout.write(renderWebBundleLicenses());

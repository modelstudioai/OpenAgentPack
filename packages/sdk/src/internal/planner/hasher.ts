import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";
import { collectFiles } from "../utils/collect-files.ts";
import { contentHash } from "../utils/hash.ts";
import { getResourceDeclaration } from "./declaration.ts";

export async function computeResourceHash(
	address: ResourceAddress,
	config: ProjectConfig,
	basePath?: string,
): Promise<string> {
	const decl = getDeclaration(address, config);
	if (!decl) return "";

	if (address.type === "skill") {
		const skillDecl = decl as { source: string };
		if (basePath) {
			const fileHash = computeSkillContentHash(skillDecl.source, basePath);
			return contentHash({ decl, fileHash });
		}
	}

	return contentHash(decl);
}

function getDeclaration(address: ResourceAddress, config: ProjectConfig): unknown | null {
	return getResourceDeclaration(address, config);
}

export function computeSkillContentHash(source: string, basePath: string): string {
	const fullPath = resolve(dirname(basePath), source);
	const stat = statSync(fullPath, { throwIfNoEntry: false });

	if (stat?.isDirectory()) {
		const parts = collectFiles(fullPath, "").map((file) => `${file.relativePath}:${file.content.toString("utf-8")}`);
		return contentHash(parts.join("\n"));
	}

	if (stat?.isFile()) {
		// For .zip files, hash the binary content directly
		if (fullPath.endsWith(".zip")) {
			const content = readFileSync(fullPath);
			return contentHash(content.toString("base64"));
		}
		const content = readFileSync(fullPath, "utf-8");
		return contentHash(content);
	}

	return "";
}

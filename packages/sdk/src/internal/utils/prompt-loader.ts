import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";

export function isFileReference(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}

export async function loadPrompt(value: string, basePath: string): Promise<string> {
	if (!isFileReference(value)) return value;
	const fullPath = resolve(dirname(basePath), value);
	try {
		return await readFile(fullPath, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			throw new UserError(`Prompt file not found: ${fullPath}`);
		}
		throw new UserError(`Failed to read prompt file: ${fullPath}`);
	}
}

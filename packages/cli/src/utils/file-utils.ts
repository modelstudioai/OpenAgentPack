import { existsSync } from "node:fs";
import { access } from "node:fs/promises";

/** Check whether a path exists and is accessible (synchronous). */
export function fileExistsSync(path: string): boolean {
	return existsSync(path);
}

/** Check whether a path exists and is accessible. */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const AGENTS_FILE_PREFIX = "Agents__";

export function hasAgentsFilePrefix(name: string): boolean {
	return name.startsWith(AGENTS_FILE_PREFIX);
}

export function applyAgentsFilePrefix(name: string): string {
	return hasAgentsFilePrefix(name) ? name : `${AGENTS_FILE_PREFIX}${name}`;
}

export function stripAgentsFilePrefix(name: string): string {
	return hasAgentsFilePrefix(name) ? name.slice(AGENTS_FILE_PREFIX.length) : name;
}

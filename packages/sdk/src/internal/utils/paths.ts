export function deriveStatePath(configPath: string): string {
	return /\.ya?ml$/i.test(configPath) ? configPath.replace(/\.ya?ml$/i, ".state.json") : `${configPath}.state.json`;
}

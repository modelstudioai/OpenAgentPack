import { UserError } from "../errors.ts";

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export function interpolateEnvVars(
	value: string,
	resolve = false,
	environment: Record<string, string | undefined> = process.env,
): string {
	return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
		if (!resolve) return match;
		const resolvedValue = environment[varName];
		if (resolvedValue === undefined) {
			throw new UserError(`Environment variable '${varName}' is not set`);
		}
		return resolvedValue;
	});
}

export function interpolateObjectEnv(
	value: unknown,
	environment: Record<string, string | undefined> = process.env,
): unknown {
	if (typeof value === "string") return interpolateEnvVars(value, true, environment);
	if (Array.isArray(value)) return value.map((entry) => interpolateObjectEnv(entry, environment));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			key,
			interpolateObjectEnv(entry, environment),
		]),
	);
}

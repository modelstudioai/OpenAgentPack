import { UserError } from "../errors.ts";

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export function interpolateEnvVars(value: string, resolve = false): string {
	return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
		if (!resolve) return match;
		const val = process.env[varName];
		if (val === undefined) {
			throw new UserError(`Environment variable '${varName}' is not set`);
		}
		return val;
	});
}

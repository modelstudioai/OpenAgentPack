import { UserError } from "../errors.ts";

export function isDeploymentEnvironmentVariableMap(value: unknown): value is Record<string, string> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!Object.hasOwn(value, "__proto__") &&
		Object.values(value).every((variableValue) => typeof variableValue === "string")
	);
}

export function getDeploymentEnvironmentVariablesIssue(
	provider: string,
	value: unknown,
): { kind: "invalid" | "unsupported"; message: string } | undefined {
	if (value === undefined) return undefined;
	if (value !== null && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
		return {
			kind: "invalid",
			message:
				"Deployment environment_variables does not support the reserved key '__proto__' / Deployment environment_variables 不支持保留键 '__proto__'。",
		};
	}
	if (provider === "bailian") {
		if (isDeploymentEnvironmentVariableMap(value)) return undefined;
		return {
			kind: "invalid",
			message:
				"Bailian Deployment environment_variables must be a string-valued object / 百炼 Deployment 的 environment_variables 必须为字符串键值对象。",
		};
	}
	if (provider === "qoder") {
		if (typeof value === "string") return undefined;
		return {
			kind: "invalid",
			message:
				"Qoder Deployment environment_variables must use the provider's string format / Qoder Deployment 的 environment_variables 必须使用服务商的字符串格式。",
		};
	}
	return {
		kind: "unsupported",
		message:
			"Deployment environment_variables are supported only by Bailian and Qoder / Deployment 环境变量仅支持百炼和 Qoder。",
	};
}

export function assertDeploymentEnvironmentVariables(provider: string, value: unknown): void {
	const issue = getDeploymentEnvironmentVariablesIssue(provider, value);
	if (issue) throw new UserError(issue.message);
}

import type { CredentialDecl } from "../types/config.ts";

interface CredentialPolicyIssue {
	field: string;
	code: string;
	message: string;
}

/** Keep Bailian's injection policy separate from other providers' legacy networking contract. */
export function validateCredentialPolicy(provider: string, credential: CredentialDecl): CredentialPolicyIssue[] {
	if (provider === "bailian") return [];
	const issues: CredentialPolicyIssue[] = [];
	for (const [field, value] of [
		["networking.allowed_hosts", credential.networking?.allowed_hosts],
		["injection_location", credential.injection_location],
	] as const) {
		if (value !== undefined) {
			issues.push({
				field,
				code: `${field}.unsupported`,
				message: `Credential ${field} is only supported by bailian; remove it or pin this vault to bailian.`,
			});
		}
	}
	if (
		credential.type === "environment_variable" &&
		credential.networking !== undefined &&
		credential.networking.type === undefined
	) {
		issues.push({
			field: "networking.type",
			code: "networking.type.required",
			message: `Credential networking.type is required for provider '${provider}' when networking is declared.`,
		});
	}
	return issues;
}

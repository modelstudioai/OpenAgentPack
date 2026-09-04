import type { CredentialDecl } from "../types/config.ts";

export const BAILIAN_CREDENTIAL_INJECTION_LOCATION = Object.freeze({ header: true, body: false });
export const FIXED_CREDENTIAL_INJECTION_MESSAGE =
	"Credential injection_location cannot be configured; Bailian uses fixed header: true, body: false.";

interface CredentialPolicyIssue {
	field: string;
	code: string;
	message: string;
}

/** Keep Bailian's injection policy separate from other providers' legacy networking contract. */
export function validateCredentialPolicy(
	provider: string,
	credential: Pick<CredentialDecl, "type" | "networking"> & { injection_location?: unknown },
): CredentialPolicyIssue[] {
	const issues: CredentialPolicyIssue[] = [];
	if (credential.injection_location !== undefined) {
		issues.push({
			field: "injection_location",
			code: "injection_location.unsupported",
			message: FIXED_CREDENTIAL_INJECTION_MESSAGE,
		});
	}
	if (provider === "bailian") return issues;
	if (credential.networking?.allowed_hosts !== undefined) {
		issues.push({
			field: "networking.allowed_hosts",
			code: "networking.allowed_hosts.unsupported",
			message:
				"Credential networking.allowed_hosts is only supported by bailian; remove it or pin this vault to bailian.",
		});
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

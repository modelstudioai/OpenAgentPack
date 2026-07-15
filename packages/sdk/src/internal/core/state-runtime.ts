import { UserError } from "../errors.ts";
import type { ResourceAddress, ResourceType } from "../types/state.ts";

export function parseStateAddress(address: string, options: { requireProvider?: boolean } = {}): ResourceAddress {
	const parts = address.split(".");
	if (options.requireProvider && parts.length !== 3) {
		throw new UserError("Address format: <provider>.<type>.<name> (all three segments required)");
	}
	if (!options.requireProvider && parts.length !== 2 && parts.length !== 3) {
		throw new UserError("Address format: [provider.]type.name");
	}

	if (parts.length === 3) {
		const [provider, type, name] = parts as [string, string, string];
		return { provider, type: type as ResourceType, name };
	}

	const [type, name] = parts as [string, string];
	return { provider: "", type: type as ResourceType, name };
}

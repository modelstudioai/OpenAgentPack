import { DEFAULT_PLAYBOOK_PROVIDER } from "./metadata.ts";
import type { EnvironmentProfile, Infrastructure, VaultProfile } from "./types.ts";

/**
 * Provider-aware cloud infrastructure.
 *
 * EVERY provider needs a cloud sandbox environment — a session always runs inside one. Bailian's
 * sandbox installs `bailian-cli` (the `bl` binary); other providers ship a bare cloud sandbox
 * (no packages), since they don't depend on bailian-cli.
 *
 * The credential vault is optional: bailian needs one (holding its own `DASHSCOPE_API_KEY` for
 * the `bl` CLI to call DashScope). Other providers run on managed infra and currently define no
 * vault — no provisioning, and the user is never asked for a rival vendor's API key.
 */
const BAILIAN_ENVIRONMENT: EnvironmentProfile = {
	name: "bailian-cli",
	description: "百炼 CLI 云端环境",
	config: {
		type: "cloud",
		networking: {
			type: "unrestricted",
		},
		packages: {
			npm: ["bailian-cli"],
		},
	},
};

const BAILIAN_VAULT: VaultProfile = {
	name: "secrets",
	display_name: "Cli Secrets",
	credentials: [
		{
			name: "DASHSCOPE_API_KEY",
			type: "environment_variable",
			secret_name: "DASHSCOPE_API_KEY",
			networking: {
				type: "unrestricted",
			},
		},
	],
};

/** A bare cloud sandbox — unrestricted networking, no packages installed. */
function bareEnvironment(provider: string): EnvironmentProfile {
	return {
		name: `${provider}-cli`,
		description: `${provider} 云端环境`,
		config: {
			type: "cloud",
			networking: {
				type: "unrestricted",
			},
		},
	};
}

export function getInfrastructure(provider: string = DEFAULT_PLAYBOOK_PROVIDER): Infrastructure {
	const environment = provider === DEFAULT_PLAYBOOK_PROVIDER ? BAILIAN_ENVIRONMENT : bareEnvironment(provider);
	// Only bailian defines a vault today; other providers run on managed infra with no credential
	// store. Add a per-provider vault here when a non-bailian provider gains a credential requirement.
	const vault = provider === DEFAULT_PLAYBOOK_PROVIDER ? BAILIAN_VAULT : undefined;
	return { environment, vault };
}

/**
 * Gate a Playbook submission. Returns true to proceed. The server provisions
 * server-side, so submission always proceeds — there is no client-side gate.
 */
export async function provisionGate(_slug: string): Promise<boolean> {
	return true;
}

/**
 * Whether submitting this Playbook will trigger first-use provisioning — a slow
 * upload+scan of the Playbook's custom skill (a few minutes), distinct from the
 * sub-second create of a warm Playbook. Drives the run modal's "环境准备中" copy.
 * Provisioning happens server-side with no client-visible state, so this always
 * reports false.
 */
export function willProvision(_slug: string): boolean {
	return false;
}

import type { SessionGithubRepositoryResource } from "../types/session.ts";
import { resolveRepositoryMountPath } from "../utils/sandbox-mount.ts";

export function resolveGithubRepositoryMountPath(provider: string, resource: SessionGithubRepositoryResource): string {
	return resolveRepositoryMountPath(provider, resource);
}

/** Map the provider-neutral Git repository declaration to the provider's legacy wire discriminator. */
export function mapGithubRepositorySessionResource(
	resource: SessionGithubRepositoryResource,
	options: {
		mapUrl?: (url: string) => string;
		mapMountPath?: (resource: SessionGithubRepositoryResource) => string | undefined;
	} = {},
): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		type: "github_repository",
		url: options.mapUrl?.(resource.url) ?? resource.url,
		authorization_token: resource.authorization_token,
	};
	if (resource.checkout?.branch) entry.checkout = { type: "branch", name: resource.checkout.branch };
	else if (resource.checkout?.commit) entry.checkout = { type: "commit", sha: resource.checkout.commit };
	const mountPath = options.mapMountPath?.(resource) ?? resource.mount_path;
	if (mountPath) entry.mount_path = mountPath;
	return entry;
}

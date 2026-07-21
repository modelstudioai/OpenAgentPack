import { UserError } from "../errors.ts";
import type { SessionGithubRepositoryResource } from "../types/session.ts";
import { providerMountPrefix } from "../utils/sandbox-mount.ts";

export function resolveGithubRepositoryMountPath(provider: string, resource: SessionGithubRepositoryResource): string {
	const prefix = providerMountPrefix(provider);
	if (!prefix) throw new UserError(`Provider '${provider}' has no declared mount path prefix.`);
	if (resource.mount_path) {
		if (resource.mount_path !== prefix && !resource.mount_path.startsWith(`${prefix}/`)) {
			throw new UserError(`${provider} GitHub Session resource mount_path must start with '${prefix}/'.`);
		}
		return resource.mount_path;
	}
	const repositoryName = new URL(resource.url).pathname
		.split("/")
		.filter(Boolean)
		.at(-1)
		?.replace(/\.git$/i, "");
	if (!repositoryName) {
		throw new UserError(`Cannot derive a ${provider} GitHub mount path from repository URL '${resource.url}'.`);
	}
	return provider === "qoder" ? `${prefix}/workspace/${repositoryName}` : `${prefix}/${repositoryName}`;
}

/** Map the provider-neutral GitHub resource declaration to the shared CAS wire shape. */
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

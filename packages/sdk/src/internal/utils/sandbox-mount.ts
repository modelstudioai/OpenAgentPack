// Single source of truth for where an uploaded file actually lands inside the agent sandbox.
//
// Every provider owns a fixed absolute mount root. Keep wire mapping and prompt hints on the
// same policy so the model is told the exact path sent to the provider.
//
// Pure string ops only (no `node:path`): this module ships to the browser via the SDK bundle.

import { UserError } from "../errors.ts";
import type { SessionBindings, SessionGithubRepositoryResource } from "../types/session.ts";

const PROVIDER_MOUNT_PREFIXES: Readonly<Record<string, string>> = {
	qoder: "/data",
	claude: "/workspace",
	bailian: "/mnt",
	ark: "/mnt",
};

function joinAbsolute(prefix: string, sub: string): string {
	const left = prefix.replace(/\/+$/, "");
	const right = sub.replace(/^\/+/, "");
	return `${left}/${right}`;
}

/** Quote an arbitrary path as one POSIX shell word. */
function quoteShellWord(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function providerMountPrefix(provider: string): string | undefined {
	return PROVIDER_MOUNT_PREFIXES[provider];
}

/**
 * Map the SDK-sent `mount_path` to the absolute path the file occupies inside the sandbox.
 * Prefix provider-relative paths with the provider's fixed mount root. Paths that already
 * use the correct root are preserved.
 * - unknown provider: return the path unchanged (conservative).
 */
export function resolveSandboxMountPath(provider: string, mountPath: string): string {
	const prefix = providerMountPrefix(provider);
	if (!prefix) return mountPath;
	if (mountPath === prefix || mountPath.startsWith(`${prefix}/`)) return mountPath;
	if (mountPath.startsWith("/")) {
		throw new UserError(`${provider} mount_path must start with '${prefix}/'; received '${mountPath}'.`);
	}
	return joinAbsolute(prefix, mountPath);
}

/** Files as carried by `SessionBindings.files` — only `mount_path` matters for the hint. */
export interface MountedFile {
	mount_path: string;
}

/** Resolve the provider path used for a mounted Git repository. */
export function resolveRepositoryMountPath(provider: string, resource: SessionGithubRepositoryResource): string {
	const prefix = providerMountPrefix(provider);
	if (!prefix) throw new UserError(`Provider '${provider}' has no declared mount path prefix.`);
	if (resource.mount_path) {
		if (resource.mount_path !== prefix && !resource.mount_path.startsWith(`${prefix}/`)) {
			throw new UserError(`${provider} Git repository Session resource mount_path must start with '${prefix}/'.`);
		}
		return resource.mount_path;
	}
	// Accept URL remotes as well as scp-like SSH remotes such as git@host:team/repo.git.
	const repositoryName = resource.url
		.replace(/[?#].*$/, "")
		.split(/[/:]/)
		.filter(Boolean)
		.at(-1)
		?.replace(/\.git$/i, "");
	if (!repositoryName) {
		throw new UserError(`Cannot derive a ${provider} Git repository mount path from URL '${resource.url}'.`);
	}
	return provider === "qoder" ? `${prefix}/workspace/${repositoryName}` : `${prefix}/${repositoryName}`;
}

/**
 * Build an English hint listing the real sandbox paths of the uploaded files, so the model
 * knows where to read them. Returns "" when there are no files.
 */
export function composeFileMountHint(files: MountedFile[] | undefined, provider: string): string {
	if (!files || files.length === 0) return "";
	const lines = files.map((f) => `- ${resolveSandboxMountPath(provider, f.mount_path)}`);
	return [
		"The user uploaded files. They are available at the following sandbox paths:",
		...lines,
		"Read them from these paths when relevant.",
	].join("\n");
}

/** Prepend the file-mount hint to a prompt. Returns the prompt unchanged when there are no files. */
export function prependFileHint(prompt: string, files: MountedFile[] | undefined, provider: string): string {
	const hint = composeFileMountHint(files, provider);
	if (!hint) return prompt;
	return `${hint}\n\n${prompt}`;
}

const FILE_MENTION_SENTINEL_RE = /\u27E6file:(.+?)\u27E7/g;

/** 将 prompt 内 ⟦file:mountPath⟧ 占位符替换为 provider 感知的真实 sandbox 路径 */
export function rewriteFileMentions(prompt: string, provider: string): string {
	return prompt.replace(FILE_MENTION_SENTINEL_RE, (_match, mountPath: string) =>
		resolveSandboxMountPath(provider, mountPath),
	);
}

/** 发送给 provider 前统一处理：先替换 mention 占位符，再 prepend 文件 hint */
export function preparePromptForProvider(prompt: string, files: MountedFile[] | undefined, provider: string): string {
	return prependFileHint(rewriteFileMentions(prompt, provider), files, provider);
}

/** Prepare only the first user message for a newly created Session. */
export function prepareInitialSessionPrompt(prompt: string, bindings: SessionBindings, provider: string): string {
	const prepared = preparePromptForProvider(prompt, bindings.files, provider);
	const repositories = (bindings.resources ?? []).filter(
		(resource): resource is SessionGithubRepositoryResource => resource.type === "github_repository",
	);
	if (repositories.length === 0) return prepared;

	const paths = repositories.map((resource) => resolveRepositoryMountPath(provider, resource));
	if (paths.length === 1) {
		const path = paths[0]!;
		return [
			`The Git working tree for this task is mounted at \`${path}\`.`,
			"Work only inside this directory unless the user explicitly requests otherwise.",
			"Prefix every shell command with:",
			`cd -- ${quoteShellWord(path)} &&`,
			`Use absolute paths under \`${path}\` for non-shell file tools.`,
			"",
			prepared,
		].join("\n");
	}
	const lines = ["Git working trees for this task are mounted at:", ...paths.map((path) => `- ${path}`)];
	lines.push("Choose the appropriate working tree for the task before inspecting or modifying files.");
	return `${lines.join("\n")}\n\n${prepared}`;
}

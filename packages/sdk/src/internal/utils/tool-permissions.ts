import type { AgentToolsDecl } from "../types/config.ts";

export type ToolPermission = "allow" | "ask";

export interface ResolvedBuiltinTool {
	configuredName: string;
	wireName: string;
	permission: ToolPermission;
}

/** Canonical comparison key: case- and separator-insensitive across provider vocabularies. */
export function canonicalToolName(name: string): string {
	return name
		.trim()
		.replace(/[^a-zA-Z0-9]+/g, "")
		.toLowerCase();
}

/** Resolve provider wire names and permission overrides behind one shared interface. */
export function resolveBuiltinTools(
	tools: AgentToolsDecl,
	options: { supportedWireNames?: ReadonlySet<string>; toWireName?: (name: string) => string } = {},
): ResolvedBuiltinTool[] {
	const permissionByName = new Map<string, ToolPermission>();
	for (const [name, permission] of Object.entries(tools.permissions ?? {})) {
		permissionByName.set(canonicalToolName(name), permission);
	}

	const supportedByName = options.supportedWireNames
		? new Map([...options.supportedWireNames].map((name) => [canonicalToolName(name), name]))
		: undefined;

	return tools.builtin.flatMap((configuredName) => {
		const candidate = options.toWireName?.(configuredName) ?? configuredName;
		const wireName = supportedByName?.get(canonicalToolName(candidate)) ?? (supportedByName ? undefined : candidate);
		if (!wireName) return [];
		return [
			{
				configuredName,
				wireName,
				permission: permissionByName.get(canonicalToolName(configuredName)) ?? tools.default_permission ?? "allow",
			},
		];
	});
}

export function toPermissionPolicy(permission: ToolPermission): { type: "always_allow" | "always_ask" } {
	return { type: permission === "ask" ? "always_ask" : "always_allow" };
}

export function permissionFromWire(rawPolicy: unknown): ToolPermission | undefined {
	const type =
		typeof rawPolicy === "string"
			? rawPolicy
			: rawPolicy && typeof rawPolicy === "object"
				? (rawPolicy as { type?: unknown }).type
				: undefined;
	if (type === "always_ask") return "ask";
	if (type === "always_allow") return "allow";
	return undefined;
}

/** Preserve remote permission policies when syncing provider tool configs back to YAML. */
export function permissionOverridesFromWire(
	configs: Array<{ name: string; enabled?: boolean; permission_policy?: unknown }>,
	toConfigName: (name: string) => string = (name) => name,
): Record<string, ToolPermission> | undefined {
	const permissions: Record<string, ToolPermission> = {};
	for (const config of configs) {
		if (config.enabled === false) continue;
		const permission = permissionFromWire(config.permission_policy);
		if (permission) permissions[toConfigName(config.name)] = permission;
	}
	return Object.keys(permissions).length ? permissions : undefined;
}

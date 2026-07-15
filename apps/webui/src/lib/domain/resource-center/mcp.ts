import { listPlaybooks, resolveSeedPlaybookMcpServers } from "@openagentpack/playbooks";
import type { ReferencedMcpRow, ResourceAgentRow } from "./types";

/**
 * Current-playbook MCP references joined against each current-app cloud agent's actual
 * `mcp_servers`. MCPs are referenced resources embedded in the agent config, so identity is by
 * declaration (`name`, plus `url` when known) and the cloud side is used for drift diagnostics.
 */
export function deriveReferencedMcpServers(agents: ResourceAgentRow[]): ReferencedMcpRow[] {
	const declared = new Map<string, ReferencedMcpRow>();
	for (const playbook of listPlaybooks()) {
		for (const server of resolveSeedPlaybookMcpServers(playbook.id)) {
			const key = mcpKey(server.type, server.name, server.url);
			const row = declared.get(key);
			if (row) {
				row.declaredBy.push(playbook.id);
			} else {
				declared.set(key, {
					key,
					name: server.name,
					type: server.type,
					url: server.url,
					declaredBy: [playbook.id],
					attachedAgents: [],
					missingAgents: [],
					status: "declared",
				});
			}
		}
	}

	const rows = new Map(declared);
	const declaredKeysByName = new Map<string, string[]>();
	const declaredBySets = new Map<string, Set<string>>();
	for (const row of declared.values()) {
		const keys = declaredKeysByName.get(row.name) ?? [];
		keys.push(row.key);
		declaredKeysByName.set(row.name, keys);
		declaredBySets.set(row.key, new Set(row.declaredBy));
	}

	for (const agent of agents) {
		const playbookId = agent.identity === "playbook" ? agent.playbookSlug : undefined;
		const mounted = readMcpServerNames(agent.raw.mcp_servers);
		if (playbookId) {
			for (const row of declared.values()) {
				if (!declaredBySets.get(row.key)?.has(playbookId)) continue;
				if (mounted.has(row.name)) row.attachedAgents.push(agent.name);
				else row.missingAgents.push(agent.name);
			}
		}

		for (const name of mounted) {
			const keys = declaredKeysByName.get(name);
			if (keys?.length) continue;
			const key = `extra:${name}`;
			const row =
				rows.get(key) ??
				({
					key,
					name,
					type: "custom",
					declaredBy: [],
					attachedAgents: [],
					missingAgents: [],
					status: "extra",
				} satisfies ReferencedMcpRow);
			row.attachedAgents.push(agent.name);
			rows.set(key, row);
		}
	}

	for (const row of rows.values()) {
		if (row.status === "extra") continue;
		const attached = row.attachedAgents.length;
		const missing = row.missingAgents.length;
		if (attached === 0 && missing === 0) row.status = "declared";
		else if (attached > 0 && missing === 0) row.status = "attached";
		else if (attached > 0 && missing > 0) row.status = "partial";
		else row.status = "missing";
	}

	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mcpKey(type: "official" | "custom", name: string, url?: string): string {
	return `${type}:${name}:${url ?? ""}`;
}

export function readMcpServerNames(value: unknown): Set<string> {
	if (!Array.isArray(value)) return new Set();
	return new Set(
		value
			.map((item) => {
				if (!item || typeof item !== "object") return undefined;
				const name = (item as { name?: unknown }).name;
				return typeof name === "string" && name.trim() ? name : undefined;
			})
			.filter((name): name is string => Boolean(name)),
	);
}

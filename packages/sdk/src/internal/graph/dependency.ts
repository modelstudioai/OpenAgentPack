import { resolveAgentMaterialization } from "../core/agent-materialization.ts";
import { UserError } from "../errors.ts";
import { isSupported } from "../providers/capabilities.ts";
import { getProvider } from "../providers/registry.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";
import { addressKey } from "../types/state.ts";

export interface DependencyGraph {
	nodes: Map<string, ResourceAddress>;
	edges: Map<string, Set<string>>;
}

export function buildDependencyGraph(config: ProjectConfig, targetProviders: string[]): DependencyGraph {
	const nodes = new Map<string, ResourceAddress>();
	const edges = new Map<string, Set<string>>();

	function addNode(addr: ResourceAddress) {
		const key = addressKey(addr);
		nodes.set(key, addr);
		if (!edges.has(key)) edges.set(key, new Set());
	}

	function addEdge(from: ResourceAddress, to: ResourceAddress) {
		const fromKey = addressKey(from);
		const toKey = addressKey(to);
		edges.get(fromKey)?.add(toKey);
	}

	for (const provider of targetProviders) {
		const def = getProvider(provider);
		const caps = def?.capabilities;

		if (config.environments) {
			for (const name of Object.keys(config.environments)) {
				const decl = config.environments[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				addNode({ type: "environment", name, provider });
			}
		}

		if (config.memory_stores) {
			for (const name of Object.keys(config.memory_stores)) {
				const decl = config.memory_stores[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				if (!isSupported(caps, "memory_store")) continue;
				addNode({ type: "memory_store", name, provider });
			}
		}

		if (config.vaults) {
			for (const name of Object.keys(config.vaults)) {
				const decl = config.vaults[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				addNode({ type: "vault", name, provider });
			}
		}

		if (config.skills) {
			for (const name of Object.keys(config.skills)) {
				const decl = config.skills[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				addNode({ type: "skill", name, provider });
			}
		}

		if (config.files) {
			for (const name of Object.keys(config.files)) {
				const decl = config.files[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				addNode({ type: "file", name, provider });
			}
		}

		if (config.identities && isSupported(caps, "identity")) {
			for (const name of Object.keys(config.identities)) {
				const decl = config.identities[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				addNode({ type: "identity", name, provider });
			}
		}

		if (config.agents) {
			for (const name of Object.keys(config.agents)) {
				const decl = config.agents[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				const materialization = resolveAgentMaterialization(provider, decl);
				const agentAddr: ResourceAddress = { type: materialization.resourceType, name, provider };
				addNode(agentAddr);

				if (decl.environment && config.environments?.[decl.environment]) {
					const envAddr: ResourceAddress = {
						type: "environment",
						name: decl.environment,
						provider,
					};
					if (nodes.has(addressKey(envAddr))) {
						addEdge(agentAddr, envAddr);
					}
				}

				if (decl.skills) {
					for (const skillRef of decl.skills) {
						if (typeof skillRef !== "string") continue;
						const skillName = skillRef;
						const skillAddr: ResourceAddress = { type: "skill", name: skillName, provider };
						if (nodes.has(addressKey(skillAddr))) {
							addEdge(agentAddr, skillAddr);
						}
					}
				}

				if (decl.vault) {
					const vaultAddr: ResourceAddress = { type: "vault", name: decl.vault, provider };
					if (nodes.has(addressKey(vaultAddr))) {
						addEdge(agentAddr, vaultAddr);
					}
				}

				if (decl.memory_stores) {
					for (const msName of decl.memory_stores) {
						const msAddr: ResourceAddress = {
							type: "memory_store",
							name: msName,
							provider,
						};
						if (nodes.has(addressKey(msAddr))) {
							addEdge(agentAddr, msAddr);
						}
					}
				}

				if (decl.multiagent && isSupported(caps, "multiagent")) {
					for (const subName of decl.multiagent.agents) {
						const subDecl = config.agents[subName];
						const subType = subDecl ? resolveAgentMaterialization(provider, subDecl).resourceType : "agent";
						const subAddr: ResourceAddress = { type: subType, name: subName, provider };
						addEdge(agentAddr, subAddr);
					}
				}
			}
		}

		if (config.deployments) {
			for (const name of Object.keys(config.deployments)) {
				const decl = config.deployments[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				const depAddr: ResourceAddress = { type: "deployment", name, provider };
				addNode(depAddr);

				const agentDecl = config.agents?.[decl.agent];
				const agentType = agentDecl ? resolveAgentMaterialization(provider, agentDecl).resourceType : "agent";
				const agentAddr: ResourceAddress = { type: agentType, name: decl.agent, provider };
				if (nodes.has(addressKey(agentAddr))) addEdge(depAddr, agentAddr);

				if (decl.environment) {
					const envAddr: ResourceAddress = { type: "environment", name: decl.environment, provider };
					if (nodes.has(addressKey(envAddr))) addEdge(depAddr, envAddr);
				}

				if (decl.vaults) {
					for (const vName of decl.vaults) {
						const vAddr: ResourceAddress = { type: "vault", name: vName, provider };
						if (nodes.has(addressKey(vAddr))) addEdge(depAddr, vAddr);
					}
				}

				if (decl.memory_stores) {
					for (const msName of decl.memory_stores) {
						const msAddr: ResourceAddress = { type: "memory_store", name: msName, provider };
						if (nodes.has(addressKey(msAddr))) addEdge(depAddr, msAddr);
					}
				}

				if (decl.resources) {
					for (const r of decl.resources) {
						if (r.type === "memory_store") {
							const msAddr: ResourceAddress = { type: "memory_store", name: r.memory_store, provider };
							if (nodes.has(addressKey(msAddr))) addEdge(depAddr, msAddr);
						}
					}
				}
			}
		}

		if (config.channels && isSupported(caps, "channel")) {
			for (const name of Object.keys(config.channels)) {
				const decl = config.channels[name]!;
				if (decl.provider && decl.provider !== provider) continue;
				const channelAddr: ResourceAddress = { type: "channel", name, provider };
				addNode(channelAddr);

				const agentDecl = config.agents?.[decl.agent];
				const agentType = agentDecl ? resolveAgentMaterialization(provider, agentDecl).resourceType : "agent";
				const agentAddr: ResourceAddress = { type: agentType, name: decl.agent, provider };
				if (nodes.has(addressKey(agentAddr))) addEdge(channelAddr, agentAddr);

				const identityName = decl.identity ?? config.defaults?.identity;
				if (identityName) {
					const identityAddr: ResourceAddress = { type: "identity", name: identityName, provider };
					if (nodes.has(addressKey(identityAddr))) addEdge(channelAddr, identityAddr);
				}
			}
		}
	}

	return { nodes, edges };
}

export function topologicalSort(graph: DependencyGraph): ResourceAddress[] {
	const visited = new Set<string>();
	const sorted: ResourceAddress[] = [];
	const visiting = new Set<string>();

	function visit(key: string) {
		if (visited.has(key)) return;
		if (visiting.has(key)) {
			throw new UserError(`Circular dependency detected involving: ${key}`);
		}
		visiting.add(key);
		const deps = graph.edges.get(key) ?? new Set();
		for (const dep of deps) {
			visit(dep);
		}
		visiting.delete(key);
		visited.add(key);
		sorted.push(graph.nodes.get(key)!);
	}

	for (const key of graph.nodes.keys()) {
		visit(key);
	}

	return sorted;
}

import type { ResourceAddress, ResourceState, StateFile } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import type { IStateManager } from "./state-manager.ts";

/**
 * In-memory implementation of IStateManager.
 * Does not perform any file I/O — `save()` is a no-op.
 * Suitable for WebUI, testing, or ephemeral scenarios.
 */
export class InMemoryStateManager implements IStateManager {
	private state: StateFile;
	private index: Map<string, number>;

	private constructor(state: StateFile) {
		this.state = state;
		this.index = this.buildIndex();
	}

	private buildIndex(): Map<string, number> {
		const idx = new Map<string, number>();
		for (let i = 0; i < this.state.resources.length; i++) {
			idx.set(addressKey(this.state.resources[i]!.address), i);
		}
		return idx;
	}

	static fromJSON(data: StateFile): InMemoryStateManager {
		return new InMemoryStateManager(structuredClone(data));
	}

	static empty(): InMemoryStateManager {
		return new InMemoryStateManager({ resources: [] });
	}

	getResource(address: ResourceAddress): ResourceState | undefined {
		const i = this.index.get(addressKey(address));
		return i !== undefined ? this.state.resources[i] : undefined;
	}

	setResource(resource: ResourceState): void {
		const key = addressKey(resource.address);
		const i = this.index.get(key);
		if (i !== undefined) {
			this.state.resources[i] = resource;
		} else {
			this.index.set(key, this.state.resources.length);
			this.state.resources.push(resource);
		}
	}

	removeResource(address: ResourceAddress): void {
		const key = addressKey(address);
		const i = this.index.get(key);
		if (i === undefined) return;

		this.state.resources.splice(i, 1);
		this.index.delete(key);
		for (let j = i; j < this.state.resources.length; j++) {
			this.index.set(addressKey(this.state.resources[j]!.address), j);
		}
	}

	listResources(): ResourceState[] {
		return [...this.state.resources];
	}

	findResource(query: { type: string; name: string; provider?: string }): ResourceState | undefined {
		return this.state.resources.find((resource) => {
			const matchType = resource.address.type === query.type;
			const matchName = resource.address.name === query.name;
			const matchProvider = !query.provider || resource.address.provider === query.provider;
			return matchType && matchName && matchProvider;
		});
	}

	getStateFile(): StateFile {
		return this.state;
	}

	async save(): Promise<void> {
		// no-op: in-memory state does not persist
	}
}

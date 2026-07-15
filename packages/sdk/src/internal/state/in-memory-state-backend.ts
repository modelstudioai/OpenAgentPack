import type { StateFile } from "../types/state.ts";
import { cloneStateFile, type StateBackend, type StateScope, stateScopeKey } from "./backend.ts";
import { InMemoryStateManager } from "./in-memory-state-manager.ts";
import type { IStateManager } from "./state-manager.ts";

export class InMemoryStateBackend implements StateBackend {
	private readonly states = new Map<string, StateFile>();

	read<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T> {
		const state = this.load(scope);
		return Promise.resolve(fn(state));
	}

	async write<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T> {
		const state = this.load(scope);
		const result = await fn(state);
		this.states.set(stateScopeKey(scope), cloneStateFile(state.getStateFile()));
		return result;
	}

	getState(scope: StateScope): StateFile {
		return cloneStateFile(this.states.get(stateScopeKey(scope)) ?? { resources: [] });
	}

	private load(scope: StateScope): InMemoryStateManager {
		return InMemoryStateManager.fromJSON(this.getState(scope));
	}
}

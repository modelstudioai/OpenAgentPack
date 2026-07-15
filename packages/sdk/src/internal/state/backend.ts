import type { StateFile } from "../types/state.ts";
import type { IStateManager } from "./state-manager.ts";

export interface StateScope {
	projectId: string;
}

export interface StateBackend {
	read<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T>;
	write<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T>;
}

export function stateScopeKey(scope: StateScope): string {
	return scope.projectId;
}

export function cloneStateFile(state: StateFile): StateFile {
	return structuredClone(state);
}

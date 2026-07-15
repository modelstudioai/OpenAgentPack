import { resolve } from "node:path";
import { deriveStatePath } from "../utils/paths.ts";
import { cloneStateFile, type StateBackend, type StateScope } from "./backend.ts";
import { InMemoryStateManager } from "./in-memory-state-manager.ts";
import { type IStateManager, StateManager } from "./state-manager.ts";

export interface LocalFileStateBackendOptions {
	configPath?: string;
	statePath?: string;
}

export class LocalFileStateBackend implements StateBackend {
	private readonly configPath?: string;
	private readonly statePath?: string;

	constructor(options: LocalFileStateBackendOptions = {}) {
		this.configPath = options.configPath ? resolve(options.configPath) : undefined;
		this.statePath = options.statePath ? resolve(options.statePath) : undefined;
	}

	async read<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T> {
		const manager = await StateManager.load(this.getStatePath(scope));
		const readonlyState = InMemoryStateManager.fromJSON(cloneStateFile(manager.getStateFile()));
		return fn(readonlyState);
	}

	async write<T>(scope: StateScope, fn: (state: IStateManager) => Promise<T> | T): Promise<T> {
		const manager = await StateManager.load(this.getStatePath(scope));
		const result = await fn(manager);
		await manager.save();
		return result;
	}

	getStatePath(_scope: StateScope): string {
		if (this.statePath) return this.statePath;
		if (this.configPath) return deriveStatePath(this.configPath);
		throw new Error("LocalFileStateBackend requires configPath or statePath");
	}
}

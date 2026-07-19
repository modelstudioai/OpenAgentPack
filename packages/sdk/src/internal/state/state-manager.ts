import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResourceAddress, ResourceState, StateFile } from "../types/state.ts";
import { addressKey } from "../types/state.ts";

export interface IStateManager {
	getResource(address: ResourceAddress): ResourceState | undefined;
	setResource(resource: ResourceState): void;
	removeResource(address: ResourceAddress): void;
	listResources(): ResourceState[];
	findResource(query: { type: string; name: string; provider?: string }): ResourceState | undefined;
	getStateFile(): StateFile;
	save(): Promise<void>;
}

export class StateManager implements IStateManager {
	private state: StateFile;
	private path: string;
	private index: Map<string, number>;

	private constructor(state: StateFile, path: string) {
		this.state = state;
		this.path = path;
		this.index = this.buildIndex();
	}

	private buildIndex(): Map<string, number> {
		const idx = new Map<string, number>();
		for (let i = 0; i < this.state.resources.length; i++) {
			idx.set(addressKey(this.state.resources[i]!.address), i);
		}
		return idx;
	}

	static async load(path: string): Promise<StateManager> {
		try {
			const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			const raw = (data.resources ?? []) as Array<Record<string, unknown>>;
			const resources: ResourceState[] = raw.map((r) => ({
				address: r.address as ResourceState["address"],
				remote_id: r.remote_id as string | null,
				externally_managed: r.externally_managed === true ? true : undefined,
				version: r.version as number | undefined,
				content_hash: ((r.content_hash ?? r.desired_hash) as string) ?? "",
				desired_hash: ((r.desired_hash ?? r.content_hash) as string) ?? "",
				desired_comparable_hash: r.desired_comparable_hash as string | undefined,
				desired_readiness_baseline: r.desired_readiness_baseline as ResourceState["desired_readiness_baseline"],
				remote_hash: r.remote_hash as string | undefined,
				remote_snapshot: r.remote_snapshot,
				drift_paths: r.drift_paths as string[] | undefined,
				drift_status: r.drift_status as ResourceState["drift_status"],
			}));
			return new StateManager({ resources }, path);
		} catch (err) {
			if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
				return StateManager.initialize(path);
			}
			throw err;
		}
	}

	static initialize(path: string): StateManager {
		return new StateManager({ resources: [] }, path);
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
		// Rebuild index entries after removal point
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
		await mkdir(dirname(this.path), { recursive: true });
		const tmpPath = `${this.path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`);
			await rename(tmpPath, this.path);
		} catch (error) {
			await unlink(tmpPath).catch(() => {});
			throw error;
		}
	}
}

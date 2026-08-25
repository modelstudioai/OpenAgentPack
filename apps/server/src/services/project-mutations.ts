export type ProjectMutationKind =
	| "agent_apply"
	| "project_apply"
	| "declaration_write"
	| "git_init"
	| "git_commit"
	| "version_restore";

export interface ProjectMutationSnapshot {
	kind: ProjectMutationKind;
	started_at: string;
	operation_id?: string;
}

type MutationListener = (mutation: ProjectMutationSnapshot | null) => void;

export class ProjectMutationConflictError extends Error {
	readonly status = 409;

	constructor(message: string) {
		super(message);
		this.name = "ProjectMutationConflictError";
	}
}

export interface ProjectMutationLease {
	setOperationId(operationId: string): void;
	release(): void;
}

/**
 * One process owns one agents.yaml project, so a small in-process lease is the
 * authoritative write gate. It intentionally does not try to lock external
 * editors; file-watcher revision checks handle those changes as a later plan.
 */
export class ProjectMutationCoordinator {
	private active?: ProjectMutationSnapshot & { leaseId: symbol };
	private readonly listeners = new Set<MutationListener>();

	getSnapshot(): ProjectMutationSnapshot | null {
		if (!this.active) return null;
		const { kind, started_at, operation_id } = this.active;
		return { kind, started_at, ...(operation_id ? { operation_id } : {}) };
	}

	subscribe(listener: MutationListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	acquire(kind: ProjectMutationKind): ProjectMutationLease {
		if (this.active) {
			throw new ProjectMutationConflictError(
				`Project mutation '${this.active.kind}' is already running. Wait for it to finish and retry.`,
			);
		}

		const leaseId = Symbol(kind);
		this.active = { kind, started_at: new Date().toISOString(), leaseId };
		this.emit();
		let released = false;
		return {
			setOperationId: (operationId) => {
				if (released || this.active?.leaseId !== leaseId) return;
				this.active.operation_id = operationId;
				this.emit();
			},
			release: () => {
				if (released) return;
				released = true;
				if (this.active?.leaseId !== leaseId) return;
				this.active = undefined;
				this.emit();
			},
		};
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

export const projectMutationCoordinator = new ProjectMutationCoordinator();

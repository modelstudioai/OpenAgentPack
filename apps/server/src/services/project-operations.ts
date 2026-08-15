import { randomUUID } from "node:crypto";
import type { RuntimeFeedbackEvent } from "@openagentpack/sdk";

const PLAN_TTL_MS = 10 * 60 * 1000;
const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlanTokenRecord {
	token: string;
	agentId: string;
	projectRevision: string;
	fingerprint: string;
	destructive: boolean;
	expiresAt: number;
}

export class OperationProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "OperationProtocolError";
	}
}

export class PlanTokenStore {
	private readonly records = new Map<string, PlanTokenRecord>();

	issue(input: Omit<PlanTokenRecord, "token" | "expiresAt">): PlanTokenRecord {
		this.evictExpired();
		const record: PlanTokenRecord = {
			...input,
			token: randomUUID(),
			expiresAt: Date.now() + PLAN_TTL_MS,
		};
		this.records.set(record.token, record);
		return record;
	}

	require(token: string, agentId: string, projectRevision: string): PlanTokenRecord {
		this.evictExpired();
		const record = this.records.get(token);
		if (!record || record.agentId !== agentId || record.projectRevision !== projectRevision) {
			throw new OperationProtocolError("Plan is stale or no longer valid. Create a new plan before applying.", 409);
		}
		return record;
	}

	consume(token: string): void {
		this.records.delete(token);
	}

	invalidateAll(): void {
		this.records.clear();
	}

	private evictExpired(): void {
		const now = Date.now();
		for (const [token, record] of this.records) {
			if (record.expiresAt <= now) this.records.delete(token);
		}
	}
}

export type OperationStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface OperationEvent {
	index: number;
	type: string;
	timestamp: string;
	data: unknown;
}

export interface ProjectOperation {
	id: string;
	type: "agent.apply";
	agent_id: string;
	status: OperationStatus;
	created_at: string;
	updated_at: string;
	events: OperationEvent[];
	result?: unknown;
	error?: string;
}

type OperationListener = (event: OperationEvent | null) => void;

export interface OperationReporter {
	emit(type: string, data: unknown): void;
	feedback(event: RuntimeFeedbackEvent): void;
}

export class ProjectOperationStore {
	private readonly operations = new Map<string, ProjectOperation>();
	private readonly listeners = new Map<string, Set<OperationListener>>();
	private activeOperationId?: string;

	create(agentId: string, executor: (reporter: OperationReporter) => Promise<unknown>): ProjectOperation {
		this.evictExpired();
		if (this.activeOperationId) {
			const active = this.operations.get(this.activeOperationId);
			if (active && (active.status === "queued" || active.status === "running")) {
				throw new OperationProtocolError(
					`Another apply operation (${active.id}) is already running for this project.`,
					409,
				);
			}
		}

		const now = new Date().toISOString();
		const operation: ProjectOperation = {
			id: randomUUID(),
			type: "agent.apply",
			agent_id: agentId,
			status: "queued",
			created_at: now,
			updated_at: now,
			events: [],
		};
		this.operations.set(operation.id, operation);
		this.listeners.set(operation.id, new Set());
		this.activeOperationId = operation.id;
		queueMicrotask(() => void this.run(operation, executor));
		return operation;
	}

	get(id: string): ProjectOperation {
		this.evictExpired();
		const operation = this.operations.get(id);
		if (!operation) throw new OperationProtocolError(`Operation '${id}' was not found.`, 404);
		return operation;
	}

	subscribe(id: string, listener: OperationListener): () => void {
		this.get(id);
		const operationListeners = this.listeners.get(id) ?? new Set<OperationListener>();
		operationListeners.add(listener);
		this.listeners.set(id, operationListeners);
		return () => operationListeners.delete(listener);
	}

	private async run(
		operation: ProjectOperation,
		executor: (reporter: OperationReporter) => Promise<unknown>,
	): Promise<void> {
		operation.status = "running";
		operation.updated_at = new Date().toISOString();
		this.append(operation, "operation.started", { agent_id: operation.agent_id });
		const reporter: OperationReporter = {
			emit: (type, data) => this.append(operation, type, data),
			feedback: (event) => this.append(operation, "runtime.feedback", event),
		};
		try {
			operation.result = await executor(reporter);
			operation.status = "completed";
			this.append(operation, "operation.completed", operation.result);
		} catch (error) {
			operation.status = "failed";
			operation.error = error instanceof Error ? error.message : String(error);
			this.append(operation, "operation.failed", { message: operation.error });
		} finally {
			operation.updated_at = new Date().toISOString();
			if (this.activeOperationId === operation.id) this.activeOperationId = undefined;
			this.broadcast(operation.id, null);
		}
	}

	private append(operation: ProjectOperation, type: string, data: unknown): void {
		const event: OperationEvent = {
			index: operation.events.length,
			type,
			timestamp: new Date().toISOString(),
			data,
		};
		operation.events.push(event);
		operation.updated_at = event.timestamp;
		this.broadcast(operation.id, event);
	}

	private broadcast(id: string, event: OperationEvent | null): void {
		for (const listener of this.listeners.get(id) ?? []) listener(event);
	}

	private evictExpired(): void {
		const cutoff = Date.now() - OPERATION_TTL_MS;
		for (const [id, operation] of this.operations) {
			if (
				(operation.status === "completed" || operation.status === "failed" || operation.status === "interrupted") &&
				Date.parse(operation.updated_at) < cutoff
			) {
				this.operations.delete(id);
				this.listeners.delete(id);
			}
		}
	}
}

export const planTokenStore = new PlanTokenStore();
export const projectOperationStore = new ProjectOperationStore();

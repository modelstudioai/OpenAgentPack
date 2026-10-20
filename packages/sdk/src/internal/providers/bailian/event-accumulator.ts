import type { SessionContentBlock } from "../../types/dto.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { toSessionEvent } from "./event-mapper.ts";
import {
	BailianEventProtocolError,
	cloneEventValue,
	deriveArtifacts,
	isRecord,
	normalizeContent,
} from "./snapshot-mapper.ts";

interface MessageState {
	identity?: Record<string, unknown>;
	blocks: Map<number, SessionContentBlock>;
	pending: Record<string, unknown>[];
	completed: boolean;
	needsAuthoritativeContent?: boolean;
	lastSnapshot?: string;
	/** Only the SDK stream marks delivery; seeding history alone does not qualify for replay. */
	deliveredSnapshot?: string;
	/** Public history recovery retains identities until clear(), never silently evicting them. */
	historySeeded?: boolean;
	historyFinalContent?: boolean;
	recoveringHistory?: boolean;
}

/** One instance belongs to one logical subscription, including its reconnect attempts. */
export class BailianEventAccumulator {
	private readonly messages = new Map<string, MessageState>();
	private readonly callNames = new Map<string, string>();
	private readonly interruptedContent = new Set<string>();
	private readonly interruptedMessages = new Set<string>();
	private readonly maxEntries: number;
	private readonly boundContentBlocks: boolean;
	private pendingCount = 0;
	private recovering = false;

	constructor(options: { maxEntries?: number; boundContentBlocks?: boolean } = {}) {
		this.maxEntries = options.maxEntries ?? 1024;
		this.boundContentBlocks = options.boundContentBlocks ?? false;
		if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
			throw new RangeError("Bailian accumulator maxEntries must be a positive integer.");
		}
	}

	push(raw: Record<string, unknown>): ProviderSessionEvent | undefined {
		return this.ingest(raw, false);
	}

	/** History entries are authoritative completed events, even when lifecycle fields are absent. */
	seed(raw: Record<string, unknown>): ProviderSessionEvent | undefined {
		if (raw.object === "content") {
			throw new BailianEventProtocolError("Bailian history must contain complete events.");
		}
		return this.ingest(raw, true);
	}

	/**
	 * Browser consumers may read history while a message is still being generated.
	 * Its content has no delta watermark: expose it for display, never as an append baseline.
	 * Kept separate from seed() so existing server recovery behavior remains unchanged.
	 */
	seedSnapshot(raw: Record<string, unknown>): ProviderSessionEvent | undefined {
		if (raw.object === "content") {
			throw new BailianEventProtocolError("Bailian history must contain complete events.");
		}
		const id = typeof raw.id === "string" ? raw.id : raw.event_id;
		if (raw.status === "in_progress") {
			if (typeof id !== "string" || !id) {
				throw new BailianEventProtocolError("Bailian unfinished history is missing its event ID.");
			}
			const event = toSessionEvent(raw, { event_format: "snapshot" });
			const state = this.getState(id);
			if (state.completed) return undefined;
			this.correlateTool(event);
			state.identity = cloneEventValue(raw);
			delete state.identity.content;
			state.blocks.clear();
			this.pendingCount -= state.pending.length;
			state.pending = [];
			state.historySeeded = true;
			state.recoveringHistory = true;
			state.needsAuthoritativeContent = true;
			return event;
		}
		const event = this.seed(raw);
		if (typeof id === "string" && id) {
			const state = this.getState(id);
			state.historySeeded = true;
			// Status/tool events can change at the same ID. Freeze only finalized text/reasoning.
			state.historyFinalContent = state.identity?.type === "message" || state.identity?.type === "reasoning";
			state.recoveringHistory = false;
		}
		return event;
	}

	/** Recovery must repair older unfinished messages even if a newer message completed first. */
	pendingMessageIds(): string[] {
		return [
			...new Set([
				...this.interruptedMessages,
				...[...this.messages].filter(([, state]) => !state.completed).map(([id]) => id),
			]),
		];
	}

	captureDelivery() {
		// Capture before seeding pages: replaying old history can evict these bounded states.
		const snapshots = new Map<string, string>();
		for (const [id, state] of this.messages) {
			if (state.deliveredSnapshot !== undefined) snapshots.set(id, state.deliveredSnapshot);
		}
		return {
			has: (id: string) => snapshots.has(id),
			get: (id: string) => snapshots.get(id),
			matches: (event: ProviderSessionEvent, prior = snapshots.get(event.id ?? "")) =>
				event.id !== undefined && prior === stableKey(event.snapshot),
		};
	}

	markDelivered(event: ProviderSessionEvent): void {
		const state = event.id ? this.messages.get(event.id) : undefined;
		if (state) state.deliveredSnapshot = stableKey(event.snapshot);
	}

	/** Never append a resumed delta to a pre-disconnection partial baseline. */
	resetPartials(): void {
		for (const [id, state] of this.messages) {
			if (!state.completed) {
				this.interruptedMessages.add(id);
				if (state.blocks.size || state.pending.length || state.needsAuthoritativeContent)
					this.interruptedContent.add(id);
				this.messages.delete(id);
			}
		}
		if (this.interruptedMessages.size > this.maxEntries) {
			throw new BailianEventProtocolError("Bailian interrupted message buffer exceeded its limit.");
		}
		this.pendingCount = 0;
		this.recovering = true;
	}

	clear(): void {
		this.messages.clear();
		this.callNames.clear();
		this.interruptedContent.clear();
		this.interruptedMessages.clear();
		this.pendingCount = 0;
		this.recovering = false;
	}

	private ingest(raw: Record<string, unknown>, history: boolean): ProviderSessionEvent | undefined {
		if (raw.object === "content") return this.ingestContent(raw);
		const id = typeof raw.id === "string" ? raw.id : raw.event_id;
		if (typeof id !== "string" || !id) {
			const event = toSessionEvent(raw, { event_format: "snapshot" });
			this.correlateTool(event);
			return event;
		}
		const state = this.getState(id);
		if (!history && state.historyFinalContent) return undefined;
		if (!history && state.recoveringHistory && raw.status !== "completed") return undefined;
		const completes = history || raw.status === "completed" || (raw.object !== "message" && raw.status === undefined);
		if (state.completed && !completes) return undefined;
		const merged = mergeSparse(state.identity ?? {}, raw);
		// Identity is never inferred from the content frame's block type (for example "text").
		if (typeof merged.type !== "string" || !merged.type) {
			throw new BailianEventProtocolError("Bailian message is missing its type.");
		}
		state.identity = merged;
		if (completes && state.needsAuthoritativeContent && raw.content === undefined) {
			throw new BailianEventProtocolError("Bailian resumed message is missing an authoritative content snapshot.");
		}
		if (raw.content !== undefined) {
			state.recoveringHistory = false;
			state.needsAuthoritativeContent = false;
			this.interruptedContent.delete(id);
		}
		this.interruptedMessages.delete(id);
		if (raw.content !== undefined) this.replaceBlocks(state, normalizeContent(raw.content));
		if (state.pending.length) {
			// A final explicit content array supersedes all older orphaned fragments.
			if (!completes || raw.content === undefined) {
				for (const frame of state.pending) this.applyContent(state, frame);
			}
			this.pendingCount -= state.pending.length;
			state.pending = [];
		}
		state.completed = completes;
		if (state.historySeeded && completes) {
			state.historyFinalContent = state.identity.type === "message" || state.identity.type === "reasoning";
		}
		return this.emit(state, raw);
	}

	private ingestContent(raw: Record<string, unknown>): ProviderSessionEvent | undefined {
		if (typeof raw.msg_id !== "string" || !raw.msg_id) {
			throw new BailianEventProtocolError("Bailian content frame is missing msg_id.");
		}
		if (!Number.isInteger(raw.index) || (raw.index as number) < 0) {
			throw new BailianEventProtocolError("Bailian content frame has an invalid index.");
		}
		if (raw.delta !== true && raw.delta !== false) {
			throw new BailianEventProtocolError("Bailian content frame is missing its delta mode.");
		}
		const state = this.getState(raw.msg_id);
		if (state.completed || state.recoveringHistory) return undefined;
		if (!state.identity) {
			if (this.pendingCount >= this.maxEntries) {
				throw new BailianEventProtocolError("Bailian orphan content buffer exceeded its limit.");
			}
			state.pending.push(cloneEventValue(raw));
			state.needsAuthoritativeContent = this.recovering;
			this.pendingCount++;
			return undefined;
		}
		this.applyContent(state, raw);
		return this.emit(state, raw);
	}

	private applyContent(state: MessageState, raw: Record<string, unknown>): void {
		const index = raw.index as number;
		if (this.boundContentBlocks && !state.blocks.has(index) && state.blocks.size >= this.maxEntries) {
			throw new BailianEventProtocolError("Bailian content block buffer exceeded its limit.");
		}
		const prior = state.blocks.get(index);
		const fields = Object.fromEntries(Object.entries(raw).filter(([key]) => !CONTENT_ENVELOPE_FIELDS.has(key)));
		const baseline = raw.delta === true ? prior : prior ? { type: prior.type } : undefined;
		const block = normalizeContent([{ ...baseline, ...fields }])[0]!;
		if (raw.delta === true && typeof raw.text === "string") {
			block.text = (prior?.text ?? "") + raw.text;
		}
		state.blocks.set(index, block);
	}

	private replaceBlocks(state: MessageState, blocks: SessionContentBlock[]): void {
		if (this.boundContentBlocks && blocks.length > this.maxEntries) {
			throw new BailianEventProtocolError("Bailian content block buffer exceeded its limit.");
		}
		state.blocks.clear();
		for (const [position, block] of blocks.entries()) {
			const index =
				typeof block.index === "number" && Number.isInteger(block.index) && block.index >= 0 ? block.index : position;
			state.blocks.set(index, block);
		}
	}

	private emit(state: MessageState, raw: Record<string, unknown>): ProviderSessionEvent | undefined {
		// A sparse restart only identifies the message; it does not establish which
		// pre-disconnection text or other blocks are missing from the resumed tail.
		if (state.needsAuthoritativeContent) return undefined;
		const aggregate = cloneEventValue(state.identity!);
		if (state.blocks.size || aggregate.content !== undefined) {
			aggregate.content = [...state.blocks.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, block]) => cloneEventValue(block));
		}
		const event = toSessionEvent(aggregate, { event_format: "snapshot" });
		this.correlateTool(event);
		const serialized = stableKey(event.snapshot);
		// Only completed snapshots are deduplicated: repeated text deltas are legitimate output.
		if (state.completed && state.lastSnapshot === serialized) return undefined;
		state.lastSnapshot = serialized;
		event.raw = raw;
		return event;
	}

	private correlateTool(event: ProviderSessionEvent): void {
		if (event.type !== "tool_use" && event.type !== "tool_result") return;
		const metadata = event.snapshot?.metadata;
		const callId = metadata?.call_id;
		if (typeof callId !== "string" || !callId) return;
		if (event.tool_name) {
			this.callNames.delete(callId);
			this.callNames.set(callId, event.tool_name);
			while (this.callNames.size > this.maxEntries) this.callNames.delete(this.callNames.keys().next().value!);
		} else {
			const name = this.callNames.get(callId);
			if (name && metadata) metadata.tool_name = event.tool_name = name;
		}
		deriveArtifacts(event);
	}

	private getState(id: string): MessageState {
		let state = this.messages.get(id);
		if (state) return state;
		if (this.messages.size >= this.maxEntries) {
			const evictable = [...this.messages].find(([, item]) => item.completed && !item.historySeeded);
			if (!evictable) throw new BailianEventProtocolError("Bailian active message buffer exceeded its limit.");
			this.messages.delete(evictable[0]);
		}
		state = {
			blocks: new Map(),
			pending: [],
			completed: false,
			needsAuthoritativeContent: this.interruptedContent.has(id),
		};
		this.messages.set(id, state);
		return state;
	}
}

const CONTENT_ENVELOPE_FIELDS = new Set(["object", "msg_id", "index", "delta", "status", "id", "event_id"]);

function mergeSparse(prior: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	const merged = cloneEventValue(prior);
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue;
		merged[key] =
			key === "metadata" && isRecord(value) && isRecord(merged[key])
				? { ...merged[key], ...cloneEventValue(value) }
				: cloneEventValue(value);
	}
	return merged;
}

function stableKey(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
	);
}

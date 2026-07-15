import { dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";
import { computeComparableDesiredHash } from "../planner/comparable.ts";
import { computeResourceHash } from "../planner/hasher.ts";
import { ApiError, ConflictError } from "../providers/base-client.ts";
import { readComparableIfSupported } from "../providers/drift-support.ts";
import type { RemoteResource } from "../providers/interface.ts";
import type { DriftReadAdapter, ResourceCrudAdapter } from "../providers/resource-workflow.ts";
import type { ExecutionPlan, PlannedAction } from "../types/plan.ts";
import type { RuntimeFeedbackSink } from "../types/runtime-feedback.ts";
import { emitRuntimeFeedback } from "../types/runtime-feedback.ts";
import type { ResourceAddress, ResourceType } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";
import { skillNameFromFiles } from "../utils/skill-manifest.ts";
import type { ExecContext } from "./context.ts";
import { resolveAgentRefs, resolveDeploymentRefs } from "./resolver.ts";
import { resolveSkillFiles } from "./skill-resolver.ts";

export interface ActionResult {
	action: PlannedAction;
	status: "success" | "failed" | "skipped";
	error?: Error;
}

// The planner/graph already exclude memory_store when the provider's capability
// matrix marks it unsupported, so this is an internal invariant guard for a
// bypassed plan rather than a routine user path — the matrix is the single source
// of truth for support.
function memoryStoreUnsupported(provider: string): UserError {
	return new UserError(`Provider '${provider}' does not support memory stores`);
}

export interface ExecutionResult {
	results: ActionResult[];
	partial: boolean;
}

// Resource execution runs with bounded parallelism. create/update actions are
// grouped into dependency levels (topological layers): every action within a
// level is independent of the others, so a whole level runs concurrently —
// capped by `concurrency` — before the next level starts. delete actions always
// run serially and last, preserving the planner's reverse dependency order.
export const DEFAULT_CONCURRENCY = 6;
export const MAX_CONCURRENCY = 10;

function clampConcurrency(value?: number): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
	return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(value)));
}

export async function executePlan(
	plan: ExecutionPlan,
	ctx: ExecContext,
	options: { concurrency?: number } = {},
): Promise<ExecutionResult> {
	const concurrency = clampConcurrency(options.concurrency);
	const resultsByKey = new Map<string, ActionResult>();
	const failed = new Set<string>();

	const actionable = plan.actions.filter((a) => a.action !== "no-op");
	const mutations = actionable.filter((a) => a.action !== "delete");
	const deletions = actionable.filter((a) => a.action === "delete");

	const runAction = async (action: PlannedAction): Promise<void> => {
		const key = addressKey(action.address);

		const depFailed = action.dependencies.some((d) => failed.has(addressKey(d)));
		if (depFailed) {
			resultsByKey.set(key, { action, status: "skipped" });
			failed.add(key);
			return;
		}

		const provider = ctx.providers.get(action.address.provider);
		if (!provider) {
			resultsByKey.set(key, {
				action,
				status: "failed",
				error: new Error(`Provider '${action.address.provider}' not configured`),
			});
			failed.add(key);
			return;
		}

		try {
			const adopted = await executeAction(action, provider, ctx);
			resultsByKey.set(key, { action, status: "success" });
			if (!adopted) {
				emitRuntimeFeedback(ctx.onFeedback, {
					type: "resource_action_success",
					level: "success",
					action,
					resource: action.address,
					message: `${action.action} ${action.address.type}.${action.address.name} (${action.address.provider})`,
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			resultsByKey.set(key, { action, status: "failed", error });
			failed.add(key);
			emitRuntimeFeedback(ctx.onFeedback, {
				type: "resource_action_failed",
				level: "error",
				action,
				resource: action.address,
				message: `Failed to ${action.action} ${action.address.type}.${action.address.name}: ${error.message}`,
			});
		}
	};

	// create/update: run level-by-level with bounded parallelism, persisting once per level.
	for (const level of buildActionLevels(mutations)) {
		await runWithConcurrency(level, concurrency, runAction);
		await ctx.state.save();
	}

	// delete: run serially, preserving the planner's reverse dependency order.
	for (const action of deletions) {
		await runAction(action);
		await ctx.state.save();
	}

	const results = actionable.map((a) => resultsByKey.get(addressKey(a.address))!);
	return {
		results,
		partial: results.some((r) => r.status === "failed"),
	};
}

// Run `worker` over `items` with at most `limit` concurrent executions.
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	if (items.length === 0) return;
	let cursor = 0;
	const size = Math.min(limit, items.length);
	const runners: Promise<void>[] = [];
	for (let i = 0; i < size; i++) {
		runners.push(
			(async () => {
				while (cursor < items.length) {
					const item = items[cursor++]!;
					await worker(item);
				}
			})(),
		);
	}
	await Promise.all(runners);
}

// Group actions into dependency levels (Kahn-style layering). Only dependencies
// that are themselves part of `actions` constrain ordering; dependencies already
// satisfied (e.g. no-op resources absent from the plan) don't block. Actions
// within a returned level have no mutual dependencies and can run concurrently.
function buildActionLevels(actions: PlannedAction[]): PlannedAction[][] {
	const inSet = new Set(actions.map((a) => addressKey(a.address)));
	const remaining = new Map<string, PlannedAction>();
	const deps = new Map<string, Set<string>>();
	for (const action of actions) {
		const key = addressKey(action.address);
		remaining.set(key, action);
		const scoped = new Set<string>();
		for (const dep of action.dependencies) {
			const depKey = addressKey(dep);
			if (inSet.has(depKey)) scoped.add(depKey);
		}
		deps.set(key, scoped);
	}

	const levels: PlannedAction[][] = [];
	while (remaining.size > 0) {
		const level: PlannedAction[] = [];
		for (const [key, action] of remaining) {
			const scoped = deps.get(key)!;
			let ready = true;
			for (const depKey of scoped) {
				if (remaining.has(depKey)) {
					ready = false;
					break;
				}
			}
			if (ready) level.push(action);
		}
		// Safety net: the planner already topo-sorts, so a cycle shouldn't occur.
		// If one somehow does, drain the rest serially rather than loop forever.
		if (level.length === 0) {
			levels.push([...remaining.values()]);
			break;
		}
		for (const action of level) remaining.delete(addressKey(action.address));
		levels.push(level);
	}
	return levels;
}

type ResourceExecAdapter = ResourceCrudAdapter & DriftReadAdapter;

async function executeAction(action: PlannedAction, provider: ResourceExecAdapter, ctx: ExecContext): Promise<boolean> {
	const { address } = action;
	const { type, name } = address;
	let adopted = false;

	if (action.action === "delete") {
		const existing = ctx.state.getResource(address);
		if (!existing) return false;
		const id = existing.remote_id;

		if (id !== null) {
			try {
				switch (type) {
					case "environment":
						await provider.deleteEnvironment(id);
						break;
					case "vault":
						await provider.deleteVault(id);
						break;
					case "skill":
						await provider.deleteSkill(id);
						break;
					case "agent":
						await provider.deleteAgent(id);
						break;
					case "memory_store":
						if (!provider.deleteMemoryStore) throw memoryStoreUnsupported(address.provider);
						await provider.deleteMemoryStore(id);
						break;
					case "deployment":
						await provider.deleteDeployment(id);
						break;
					case "file":
						await provider.deleteFile(id);
						break;
				}
			} catch (err) {
				if (!ApiError.isNotFound(err)) throw err;
				emitRuntimeFeedback(ctx.onFeedback, {
					type: "resource_already_gone",
					level: "warning",
					resource: address,
					message: `${type}.${name} (${address.provider}) — already deleted remotely, cleaning up state`,
				});
			}
		}
		ctx.state.removeResource(address);
		return false;
	}

	const isUpdate = action.action === "update";
	const existingId = isUpdate ? ctx.state.getResource(address)?.remote_id : undefined;

	let result: RemoteResource;

	switch (type) {
		case "environment": {
			const decl = ctx.config.environments![name]!;
			const remoteName = decl.name ?? name;
			if (isUpdate) {
				result = await provider.updateEnvironment(existingId!, remoteName, decl);
			} else {
				try {
					result = await provider.createEnvironment(remoteName, decl);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) => provider.updateEnvironment(existing.id!, remoteName, decl),
					});
					adopted = true;
				}
			}
			break;
		}
		case "vault": {
			const decl = ctx.config.vaults![name]!;
			if (isUpdate) {
				try {
					result = await provider.createVault(name, decl);
					await provider.deleteVault(existingId!);
				} catch {
					await provider.deleteVault(existingId!);
					result = await provider.createVault(name, decl);
				}
			} else {
				try {
					result = await provider.createVault(name, decl);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: async (existing) => {
							await provider.deleteVault(existing.id!);
							return provider.createVault(name, decl);
						},
					});
					adopted = true;
				}
			}
			break;
		}
		case "skill": {
			const decl = ctx.config.skills![name]!;
			// Skip non-custom skills (e.g. anthropic/official built-ins) — they don't need uploading
			if (decl.origin && decl.origin !== "custom") {
				emitRuntimeFeedback(ctx.onFeedback, {
					type: "resource_action_success",
					level: "info",
					action,
					resource: address,
					message: `skip skill.${name} (${address.provider}) — official skill, no upload needed`,
				});
				result = { id: null, type: "skill" };
				adopted = true;
				break;
			}
			const remoteName = decl.name ?? name;
			const files = await resolveSkillFiles(decl, ctx);
			if (isUpdate) {
				result = await provider.updateSkill(existingId!, remoteName, decl, files);
			} else {
				// A skill's remote name is not always the agents.yaml key: providers register
				// it under the SKILL.md frontmatter `name` (Bailian reads it server-side,
				// claude/ark use it as the archive name). Search by both so an existing skill
				// is reliably found and adopted instead of failing on a name conflict.
				const manifestName = skillNameFromFiles(files);
				const searchNames = manifestName && manifestName !== remoteName ? [remoteName, manifestName] : [remoteName];
				// Pre-check: if a matching skill already exists, adopt it directly without
				// uploading (avoids wasteful zip upload + OSS delay).
				const existing = await findExistingByNames(provider, "skill", searchNames);
				if (existing) {
					result = existing.resource;
					emitRuntimeFeedback(ctx.onFeedback, {
						type: "resource_adopted",
						level: "info",
						resource: address,
						message: `adopt skill.${name} (${address.provider}) — already existed remotely as "${existing.name}"`,
					});
					adopted = true;
				} else {
					try {
						result = await provider.createSkill(remoteName, decl, files);
					} catch (err) {
						result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
							searchNames,
							onExisting: async (existing) => existing,
						});
						adopted = true;
					}
				}
			}
			break;
		}
		case "memory_store": {
			const createMemoryStore = provider.createMemoryStore?.bind(provider);
			const deleteMemoryStore = provider.deleteMemoryStore?.bind(provider);
			if (!createMemoryStore || !deleteMemoryStore) throw memoryStoreUnsupported(address.provider);
			const decl = ctx.config.memory_stores![name]!;
			if (isUpdate) {
				try {
					result = await createMemoryStore(name, decl);
					await deleteMemoryStore(existingId!);
				} catch {
					await deleteMemoryStore(existingId!);
					result = await createMemoryStore(name, decl);
				}
			} else {
				try {
					result = await createMemoryStore(name, decl);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: async (existing) => {
							await deleteMemoryStore(existing.id!);
							return createMemoryStore(name, decl);
						},
					});
					adopted = true;
				}
			}
			break;
		}
		case "agent": {
			const decl = ctx.config.agents![name]!;
			const remoteName = decl.name ?? name;
			const refs = resolveAgentRefs(name, ctx.config, address.provider, ctx.state);
			if (isUpdate) {
				result = await provider.updateAgent(existingId!, remoteName, decl, refs);
			} else {
				try {
					result = await provider.createAgent(remoteName, decl, refs);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) => provider.updateAgent(existing.id!, remoteName, decl, refs),
					});
					adopted = true;
				}
			}
			break;
		}
		case "deployment": {
			const decl = ctx.config.deployments![name]!;
			const refs = resolveDeploymentRefs(name, ctx.config, address.provider, ctx.state);
			if (isUpdate) {
				result = await provider.updateDeployment(existingId!, name, decl, refs, ctx.configPath ?? "");
			} else {
				try {
					result = await provider.createDeployment(name, decl, refs, ctx.configPath ?? "");
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) => provider.updateDeployment(existing.id!, name, decl, refs, ctx.configPath ?? ""),
					});
					adopted = true;
				}
			}
			break;
		}
		case "file": {
			const decl = ctx.config.files![name]!;
			const filePath = resolve(dirname(ctx.configPath ?? ""), decl.source);
			if (isUpdate) {
				// Delete the old file and re-upload
				const oldId = ctx.state.getResource(address)?.remote_id;
				if (oldId) {
					try {
						await provider.deleteFile(oldId);
					} catch {
						// best effort — old file may already be gone
					}
				}
			}
			const info = await provider.uploadFile(filePath, {
				name: decl.name,
				purpose: decl.purpose,
			});
			result = { id: info.id, type: "file" };
			break;
		}
		default:
			throw new UserError(`Unknown resource type: ${type}`);
	}

	const hash = await computeResourceHash(address, ctx.config, ctx.configPath);
	const comparableHash = computeComparableDesiredHash(address, ctx.config, provider);

	// After apply, read back the actual remote state to establish the drift
	// baseline. Cloud APIs often normalize, enrich, or transform payloads, so
	// the remote state may differ from what was sent. Using the actual remote
	// hash avoids false "Remote drift detected" on the next plan.
	let remoteHash = comparableHash;
	let remoteSnapshot: unknown;
	const remote = await readComparableIfSupported(provider, type, result.id, name);
	if (remote) {
		remoteHash = contentHash(remote.comparable);
		remoteSnapshot = remote.snapshot ?? remote.comparable;
	}

	ctx.state.setResource({
		address,
		remote_id: result.id,
		version: result.version,
		content_hash: hash,
		desired_hash: hash,
		desired_comparable_hash: remoteHash,
		remote_hash: remoteHash,
		remote_snapshot: remoteSnapshot,
		drift_status: remoteHash ? "in_sync" : undefined,
	});
	return adopted;
}

async function findExistingByNames(
	provider: Pick<ResourceCrudAdapter, "findResource">,
	type: ResourceType,
	names: string[],
): Promise<{ resource: RemoteResource; name: string } | null> {
	for (const candidate of names) {
		const found = await provider.findResource(type, candidate);
		if (found && found.id !== null) return { resource: found, name: candidate };
	}
	return null;
}

async function adoptOnConflict(
	err: unknown,
	address: ResourceAddress,
	provider: Pick<ResourceCrudAdapter, "findResource">,
	onFeedback: RuntimeFeedbackSink | undefined,
	opts: {
		searchNames?: string[];
		onExisting: (existing: RemoteResource) => Promise<RemoteResource>;
	},
): Promise<RemoteResource> {
	if (!(err instanceof ConflictError)) throw err;

	const candidates = opts.searchNames?.length ? opts.searchNames : [address.name];
	const existing = await findExistingByNames(provider, address.type, candidates);
	if (!existing) throw nameReservedError(err, address, candidates.join('" / "'));

	emitRuntimeFeedback(onFeedback, {
		type: "resource_adopted",
		level: "info",
		resource: address,
		message: `adopt ${address.type}.${address.name} (${address.provider}) — already existed remotely as "${existing.name}"`,
	});
	return opts.onExisting(existing.resource);
}

// A conflict was reported (name already exists) but the resource can't be found remotely to
// adopt it. This happens when a resource was recently deleted and the provider still reserves
// its name for a while (observed on Ark: environment names stay reserved 40s+ after DELETE,
// while the resource is 404 on GET and absent from the list). Retrying is futile within a
// command, so fail with actionable guidance instead of the raw wire error.
function nameReservedError(err: unknown, address: ResourceAddress, searchName: string): UserError {
	const detail = err instanceof ApiError ? err.message : String(err);
	return new UserError(
		`${address.provider} reported ${address.type} "${searchName}" already exists, but it could not be found remotely to adopt. ` +
			`This usually means it was recently deleted and the provider still reserves the name. ` +
			`Wait for the provider to release the name, or use a different name for ${address.type}.${address.name}. (${detail})`,
	);
}

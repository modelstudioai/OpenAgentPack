import { dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";
import { computeComparableDesiredHash } from "../planner/comparable.ts";
import { getResourceDeclaration } from "../planner/declaration.ts";
import { computeReplacementFingerprint, computeResourceHash } from "../planner/hasher.ts";
import { buildReadinessBaseline } from "../planner/plan-semantics.ts";
import { ApiError, ConflictError } from "../providers/base-client.ts";
import { DeploymentCreateConflictError } from "../providers/deployment-conflict.ts";
import { readComparableIfSupported } from "../providers/drift-support.ts";
import type { ProviderResourceMode, RemoteResource } from "../providers/interface.ts";
import type { DriftReadAdapter, ResourceCrudAdapter } from "../providers/resource-workflow.ts";
import type { ExecutionPlan, PlannedAction } from "../types/plan.ts";
import type { RuntimeFeedbackSink } from "../types/runtime-feedback.ts";
import { emitRuntimeFeedback } from "../types/runtime-feedback.ts";
import type { ResourceAddress, ResourceType } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import { contentHash, sha256 } from "../utils/hash.ts";
import { skillNameFromFiles } from "../utils/skill-manifest.ts";
import type { ExecContext } from "./context.ts";
import { resolveAgentRefs, resolveChannelRefs, resolveDeploymentRefs, resolveTemplateRefs } from "./resolver.ts";
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
	let stateUpdated = false;

	// Persist the ownership boundary even for an already-converged external
	// environment. This upgrades state written before the marker existed, so a
	// later removal from config still cannot delete the provider-owned resource.
	for (const action of plan.actions) {
		if (action.address.type !== "environment" && action.address.type !== "identity") continue;
		const existing = ctx.state.getResource(action.address);
		const externalId =
			action.address.type === "environment"
				? ctx.config.environments?.[action.address.name]?.environment_id
				: ctx.config.identities?.[action.address.name]?.identity_id;
		if (externalId && existing && !existing.externally_managed) {
			ctx.state.setResource({ ...existing, externally_managed: true });
			stateUpdated = true;
		}
	}
	if (stateUpdated) await ctx.state.save();

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

	// Qoder creates the writable default Store lazily on the first Forward Session.
	// Reconcile on every apply (including an otherwise no-op plan), so the first apply
	// after that Session converges its display metadata without creating a throwaway Session.
	await reconcileDefaultMemoryStores(ctx, new Set(plan.actions.map((action) => action.address.provider)));

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

async function reconcileDefaultMemoryStores(ctx: ExecContext, plannedProviders: ReadonlySet<string>): Promise<void> {
	const identityName = ctx.config.defaults?.identity;
	for (const [agentName, agent] of Object.entries(ctx.config.agents ?? {})) {
		const desired = agent.default_memory_store;
		if (!desired || agent.delivery?.qoder?.type !== "forward") continue;
		const providerName = "qoder";
		if ((agent.provider && agent.provider !== providerName) || !plannedProviders.has(providerName)) continue;
		const provider = ctx.providers.get(providerName);
		if (!provider?.reconcileDefaultMemoryStore || !identityName) continue;

		const identityId = ctx.state.getResource({
			type: "identity",
			name: identityName,
			provider: providerName,
		})?.remote_id;
		const templateId = ctx.state.getResource({ type: "template", name: agentName, provider: providerName })?.remote_id;
		if (!identityId || !templateId) continue;

		const result = await provider.reconcileDefaultMemoryStore(identityId, templateId, desired);
		const resource = { type: "template" as const, name: agentName, provider: providerName };
		if (result.status === "pending") {
			emitRuntimeFeedback(ctx.onFeedback, {
				type: "provider_wait",
				level: "warning",
				resource,
				message: `default memory store for template.${agentName} is pending — create the first Forward Session, then run apply again`,
			});
		} else if (result.status === "updated") {
			emitRuntimeFeedback(ctx.onFeedback, {
				type: "resource_action_success",
				level: "success",
				resource,
				message: `updated default memory store for template.${agentName} to "${desired.name}"`,
			});
		}
	}
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

// The remote object can vanish after refresh planned an update (deleted
// out-of-band, or soft-deleted in a way refresh cannot see). Failing the whole
// apply on a 404 update is wrong — recreate the resource instead.
async function executeAction(action: PlannedAction, provider: ResourceExecAdapter, ctx: ExecContext): Promise<boolean> {
	try {
		return await executeActionInner(action, provider, ctx);
	} catch (err) {
		if (action.action !== "update" || !ApiError.isNotFound(err)) throw err;
		emitRuntimeFeedback(ctx.onFeedback, {
			type: "resource_already_gone",
			level: "warning",
			action,
			resource: action.address,
			message: `update ${action.address.type}.${action.address.name} (${action.address.provider}) — not found remotely, recreating`,
		});
		ctx.state.removeResource(action.previousAddress ?? action.address);
		return executeActionInner({ ...action, action: "create", previousAddress: undefined }, provider, ctx);
	}
}

async function executeActionInner(
	action: PlannedAction,
	provider: ResourceExecAdapter,
	ctx: ExecContext,
): Promise<boolean> {
	const { address } = action;
	const { type, name } = address;
	let adopted = false;

	if (action.action === "delete") {
		const existing = ctx.state.getResource(address);
		if (!existing) return false;
		const id = existing.remote_id;
		const apiMode = existing.api_mode;

		// External-reference environments are owned outside OpenCMA; deleting them
		// here would only remove the local state entry.
		if (type === "environment" || type === "identity") {
			const externalReference =
				type === "environment"
					? ctx.config.environments?.[name]?.environment_id
					: ctx.config.identities?.[name]?.identity_id;
			if (existing.externally_managed || externalReference) {
				ctx.state.removeResource(address);
				return false;
			}
		}

		if (id !== null) {
			try {
				switch (type) {
					case "environment":
						await provider.deleteEnvironment(id, false, apiMode);
						break;
					case "vault":
						await provider.deleteVault(id, apiMode);
						break;
					case "skill":
						await provider.deleteSkill(id, apiMode);
						break;
					case "agent":
						await provider.deleteAgent(id);
						break;
					case "template":
						if (!provider.archiveTemplate)
							throw new UserError(`Provider '${address.provider}' does not support templates`);
						await provider.archiveTemplate(id, ownedForwardMemoryStoreIds(ctx, address.provider));
						break;
					case "memory_store":
						if (!provider.deleteMemoryStore) throw memoryStoreUnsupported(address.provider);
						await provider.deleteMemoryStore(id, apiMode);
						break;
					case "deployment":
						await provider.deleteDeployment(id);
						break;
					case "file":
						await provider.deleteFile(id, apiMode);
						break;
					case "identity":
						if (!provider.deleteIdentity)
							throw new UserError(`Provider '${address.provider}' does not support identities`);
						await provider.deleteIdentity(id);
						break;
					case "channel":
						if (!provider.deleteChannel)
							throw new UserError(`Provider '${address.provider}' does not support channels`);
						await provider.deleteChannel(id);
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
	const priorAddress = action.previousAddress ?? address;
	const existingId = isUpdate ? ctx.state.getResource(priorAddress)?.remote_id : undefined;
	const apiMode = resolveResourceApiMode(type, name, address.provider, ctx.config);
	const priorApiMode =
		ctx.state.getResource(priorAddress)?.api_mode ?? (address.provider === "qoder" ? "managed" : undefined);
	const apiModeChanged = isUpdate && apiMode !== undefined && priorApiMode !== apiMode;

	let result: RemoteResource;

	switch (type) {
		case "environment": {
			const decl = ctx.config.environments![name]!;
			const remoteName = decl.name ?? name;
			// External-reference environments are owned outside OpenCMA.
			// Skip remote mutations and just record the pre-existing id in state.
			if (decl.environment_id) {
				result = { id: decl.environment_id, type: "environment" };
				emitRuntimeFeedback(ctx.onFeedback, {
					type: "resource_action_success",
					level: "info",
					action,
					resource: action.address,
					message: `${action.action} ${action.address.type}.${action.address.name} (${action.address.provider}) — external reference, no remote mutation`,
				});
			} else if (apiModeChanged) {
				try {
					result = await provider.createEnvironment(remoteName, decl, apiMode);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						mode: apiMode,
						onExisting: (existing) => provider.updateEnvironment(existing.id!, remoteName, decl, apiMode),
					});
					adopted = true;
				}
				if (existingId) await provider.deleteEnvironment(existingId, false, priorApiMode);
			} else if (isUpdate) {
				// Defense in depth: ownership is a state-level fact. Never push the
				// local config onto an environment recorded as externally managed —
				// the transition back to managed requires an explicit release
				// (`agents state rm` + `agents state import`).
				const prior = ctx.state.getResource(address);
				if (prior?.externally_managed) {
					throw new UserError(
						`environment.${name} is recorded as an external reference (${prior.remote_id ?? "unknown id"}); ` +
							`refusing to modify it remotely. Restore 'environment_id' to keep it as a reference, or release it first ` +
							`with 'agents state rm environment.${name}' (then 'agents state import' to adopt it as a managed resource).`,
					);
				}
				result = await provider.updateEnvironment(existingId!, remoteName, decl, apiMode);
			} else {
				try {
					result = await provider.createEnvironment(remoteName, decl, apiMode);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						mode: apiMode,
						onExisting: (existing) => provider.updateEnvironment(existing.id!, remoteName, decl, apiMode),
					});
					adopted = true;
				}
			}
			break;
		}
		case "vault": {
			const decl = ctx.config.vaults![name]!;
			if (apiModeChanged) {
				result = await provider.createVault(name, decl, apiMode);
				if (existingId) await provider.deleteVault(existingId, priorApiMode).catch(() => undefined);
			} else if (isUpdate) {
				try {
					result = await provider.createVault(name, decl, apiMode);
					await provider.deleteVault(existingId!, apiMode);
				} catch {
					await provider.deleteVault(existingId!, apiMode);
					result = await provider.createVault(name, decl, apiMode);
				}
			} else {
				try {
					result = await provider.createVault(name, decl, apiMode);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						mode: apiMode,
						onExisting: async (existing) => {
							await provider.deleteVault(existing.id!, apiMode);
							return provider.createVault(name, decl, apiMode);
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
			if (apiModeChanged) {
				result = await provider.createSkill(remoteName, decl, files, apiMode);
				if (existingId) await provider.deleteSkill(existingId, priorApiMode).catch(() => undefined);
			} else if (isUpdate) {
				result = await provider.updateSkill(existingId!, remoteName, decl, files, apiMode);
			} else {
				// A skill's remote name is not always the agents.yaml key: providers register
				// it under the SKILL.md frontmatter `name` (Bailian reads it server-side,
				// claude/ark use it as the archive name). Search by both so an existing skill
				// is reliably found and adopted instead of failing on a name conflict.
				const manifestName = skillNameFromFiles(files);
				const searchNames = manifestName && manifestName !== remoteName ? [remoteName, manifestName] : [remoteName];
				// Pre-check: if a matching skill already exists, adopt it directly without
				// uploading (avoids wasteful zip upload + OSS delay).
				const existing = await findExistingByNames(provider, "skill", searchNames, apiMode);
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
						result = await provider.createSkill(remoteName, decl, files, apiMode);
					} catch (err) {
						result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
							mode: apiMode,
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
			if (!provider.updateMemoryStore || !provider.listMemories || !provider.createMemory || !provider.updateMemory) {
				throw memoryStoreUnsupported(address.provider);
			}
			const reconcile = async (storeId: string): Promise<RemoteResource> => {
				const store = await provider.updateMemoryStore!(
					storeId,
					{
						name,
						description: decl.description,
						metadata: decl.metadata ?? {},
					},
					apiMode,
				);

				// Declarative entries are managed seeds. Update/create those paths in place,
				// while preserving memories learned by agents at runtime.
				const current = new Map<string, { id: string; content_sha256: string }>();
				let cursor: string | undefined;
				do {
					const page = await provider.listMemories!(storeId, { limit: 100, cursor, view: "basic" }, apiMode);
					for (const memory of page.data) {
						if (memory.type === "memory") current.set(memory.path, memory);
					}
					cursor = page.has_more ? page.next_cursor : undefined;
				} while (cursor);

				for (const entry of decl.entries ?? []) {
					const existing = current.get(entry.key.replace(/^\/+/, ""));
					if (existing) {
						if (existing.content_sha256 !== sha256(entry.content)) {
							await provider.updateMemory!(
								storeId,
								existing.id,
								{
									content: entry.content,
									expected_content_sha256: existing.content_sha256,
								},
								apiMode,
							);
						}
					} else {
						await provider.createMemory!(storeId, { path: entry.key, content: entry.content }, apiMode);
					}
				}
				return store;
			};
			if (apiModeChanged) {
				result = await createMemoryStore(name, decl, apiMode);
				if (existingId) await deleteMemoryStore(existingId, priorApiMode).catch(() => undefined);
			} else if (isUpdate) {
				result = await reconcile(existingId!);
			} else {
				try {
					result = await createMemoryStore(name, decl, apiMode);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						mode: apiMode,
						onExisting: async (existing) => reconcile(existing.id!),
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
		case "template": {
			const createTemplate = provider.createTemplate?.bind(provider);
			const updateTemplate = provider.updateTemplate?.bind(provider);
			if (!createTemplate || !updateTemplate) {
				throw new UserError(`Provider '${address.provider}' does not support templates`);
			}
			const decl = ctx.config.agents![name]!;
			const remoteName = decl.name ?? name;
			const refs = resolveTemplateRefs(name, ctx.config, address.provider, ctx.state);
			if (isUpdate) {
				result = await updateTemplate(existingId!, remoteName, decl, refs);
			} else {
				try {
					result = await createTemplate(remoteName, decl, refs);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) => updateTemplate(existing.id!, remoteName, decl, refs),
					});
					adopted = true;
				}
			}
			break;
		}
		case "identity": {
			const createIdentity = provider.createIdentity?.bind(provider);
			const updateIdentity = provider.updateIdentity?.bind(provider);
			if (!createIdentity || !updateIdentity) {
				throw new UserError(`Provider '${address.provider}' does not support identities`);
			}
			const decl = ctx.config.identities![name]!;
			if (decl.identity_id) {
				const remote = await provider.findResource("identity", name, decl.identity_id);
				if (!remote?.id) {
					throw new UserError(
						`External identity.${name} '${decl.identity_id}' was not found on provider '${address.provider}'.`,
					);
				}
				result = remote;
				break;
			}
			if (isUpdate) {
				if (ctx.state.getResource(address)?.externally_managed) {
					throw new UserError(`identity.${name} is recorded as an external reference; refusing to modify it remotely.`);
				}
				result = await updateIdentity(existingId!, name, decl);
			} else {
				try {
					result = await createIdentity(name, decl);
				} catch (err) {
					if (!(err instanceof ConflictError)) throw err;
					const existing = await provider.findResource("identity", decl.external_id!);
					if (!existing?.id) throw err;
					result = await updateIdentity(existing.id, name, decl);
					adopted = true;
				}
			}
			break;
		}
		case "channel": {
			const createChannel = provider.createChannel?.bind(provider);
			const updateChannel = provider.updateChannel?.bind(provider);
			if (!createChannel || !updateChannel) {
				throw new UserError(`Provider '${address.provider}' does not support channels`);
			}
			const decl = ctx.config.channels![name]!;
			const refs = resolveChannelRefs(name, ctx.config, address.provider, ctx.state);
			if (isUpdate) {
				result = await updateChannel(existingId!, name, decl, refs);
			} else {
				try {
					result = await createChannel(name, decl, refs);
				} catch (err) {
					result = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) => updateChannel(existing.id!, name, decl, refs),
					});
					adopted = true;
				}
			}
			break;
		}
		case "deployment": {
			const decl = ctx.config.deployments![name]!;
			const refs = resolveDeploymentRefs(name, ctx.config, address.provider, ctx.state);
			const hasLocalFileSources = decl.resources?.some(
				(resource) => resource.type === "file" && !resource.file_id && Boolean(resource.source),
			);
			const materializeDeployment = async (): Promise<RemoteResource> => {
				try {
					return await provider.createDeployment(name, decl, refs, ctx.configPath ?? "");
				} catch (err) {
					const preparedFiles = err instanceof DeploymentCreateConflictError ? err.preparedFiles : undefined;
					const existing = await adoptOnConflict(err, address, provider, ctx.onFeedback, {
						onExisting: (existing) =>
							provider.updateDeployment(existing.id!, name, decl, refs, ctx.configPath ?? "", preparedFiles),
					});
					adopted = true;
					return existing;
				}
			};
			if (isUpdate && existingId) {
				result = await provider.updateDeployment(existingId, name, decl, refs, ctx.configPath ?? "");
			} else {
				// A deployment with local file sources uploads before its create request. If the
				// remote deployment already exists, an optimistic create would upload once,
				// conflict, then upload again during adoption. Preflight this side-effecting
				// path so the existing deployment is updated with a single set of uploads.
				const existing = hasLocalFileSources ? await findExistingByNames(provider, "deployment", [name]) : null;
				if (existing) {
					result = await provider.updateDeployment(existing.resource.id!, name, decl, refs, ctx.configPath ?? "");
					emitRuntimeFeedback(ctx.onFeedback, {
						type: "resource_adopted",
						level: "info",
						resource: address,
						message: `adopt deployment.${name} (${address.provider}) — already existed remotely as "${existing.name}"`,
					});
					adopted = true;
				} else {
					result = await materializeDeployment();
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
						await provider.deleteFile(oldId, priorApiMode);
					} catch {
						// best effort — old file may already be gone
					}
				}
			}
			const info = await provider.uploadFile(filePath, { name: decl.name, purpose: decl.purpose }, apiMode);
			result = { id: info.id, type: "file" };
			break;
		}
		default:
			throw new UserError(`Unknown resource type: ${type}`);
	}

	const hash = await computeResourceHash(address, ctx.config, ctx.configPath, ctx.state);
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

	// The externally-managed marker is sticky: it survives applies and is only
	// cleared by removing the resource from state (`agents state rm` / destroy).
	const priorResource = ctx.state.getResource(priorAddress);
	ctx.state.setResource({
		address,
		remote_id: result.id,
		externally_managed:
			priorResource?.externally_managed ||
			(type === "environment" && ctx.config.environments?.[name]?.environment_id) ||
			(type === "identity" && ctx.config.identities?.[name]?.identity_id)
				? true
				: undefined,
		api_mode: apiMode,
		version: result.version,
		content_hash: hash,
		desired_hash: hash,
		desired_comparable_hash: remoteHash,
		desired_readiness_baseline: buildReadinessBaseline(getResourceDeclaration(address, ctx.config)),
		remote_hash: remoteHash,
		remote_snapshot: remoteSnapshot,
		replacement_fingerprint: computeReplacementFingerprint(address, ctx.config),
		drift_paths: [],
		drift_status: remoteHash ? "in_sync" : undefined,
	});
	if (action.previousAddress) ctx.state.removeResource(action.previousAddress);
	return adopted;
}

function ownedForwardMemoryStoreIds(ctx: ExecContext, provider: string): string[] {
	return ctx.state
		.listResources()
		.filter(
			(resource) =>
				resource.address.provider === provider &&
				resource.address.type === "memory_store" &&
				resource.api_mode === "forward" &&
				typeof resource.remote_id === "string",
		)
		.map((resource) => resource.remote_id as string);
}

function resolveResourceApiMode(
	type: ResourceType,
	name: string,
	provider: string,
	config: ExecContext["config"],
): ProviderResourceMode | undefined {
	if (
		provider !== "qoder" ||
		(type !== "environment" && type !== "skill" && type !== "vault" && type !== "memory_store" && type !== "file")
	) {
		return undefined;
	}
	// An external Environment reference can resolve in either Qoder API domain.
	if (type === "environment" && config.environments?.[name]?.environment_id) return "auto";

	let managed = false;
	let forward = false;
	for (const agent of Object.values(config.agents ?? {})) {
		if (agent.provider && agent.provider !== provider) continue;
		const referenced =
			type === "environment"
				? agent.environment === name
				: type === "skill"
					? agent.skills?.some((skill) =>
							typeof skill === "string" ? skill === name : skill.type === "custom" && skill.skill_id === name,
						)
					: type === "vault"
						? agent.vault === name
						: type === "memory_store"
							? agent.memory_stores?.includes(name)
							: agent.files?.includes(name);
		if (!referenced) continue;
		if (agent.delivery?.qoder?.type === "forward") forward = true;
		else managed = true;
	}
	if (managed && forward) {
		throw new UserError(
			`Qoder ${type}.${name} is referenced by both Managed and Forward agents; declare separate resources for each API domain.`,
		);
	}
	return forward ? "forward" : "managed";
}

async function findExistingByNames(
	provider: Pick<ResourceCrudAdapter, "findResource">,
	type: ResourceType,
	names: string[],
	mode?: ProviderResourceMode,
): Promise<{ resource: RemoteResource; name: string } | null> {
	for (const candidate of names) {
		const found = await provider.findResource(type, candidate, undefined, mode);
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
		mode?: ProviderResourceMode;
		onExisting: (existing: RemoteResource) => Promise<RemoteResource>;
	},
): Promise<RemoteResource> {
	if (!(err instanceof ConflictError)) throw err;

	const candidates = opts.searchNames?.length ? opts.searchNames : [address.name];
	const existing = await findExistingByNames(provider, address.type, candidates, opts.mode);
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
	if (
		address.type === "channel" &&
		err instanceof ApiError &&
		err.responseBody.includes("CHANNEL_CREDENTIAL_CONFLICT")
	) {
		return new UserError(
			`${address.provider} rejected channel.${address.name} because its credentials are already used by another Channel. ` +
				`Keep the existing Channel address so it can be updated in place, remove the old Channel first, or use a different credential set. (${detail})`,
		);
	}
	return new UserError(
		`${address.provider} reported ${address.type} "${searchName}" already exists, but it could not be found remotely to adopt. ` +
			`This usually means it was recently deleted and the provider still reserves the name. ` +
			`Wait for the provider to release the name, or use a different name for ${address.type}.${address.name}. (${detail})`,
	);
}

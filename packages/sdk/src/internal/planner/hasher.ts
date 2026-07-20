import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress, ResourceState } from "../types/state.ts";
import { collectFiles } from "../utils/collect-files.ts";
import { contentHash } from "../utils/hash.ts";
import { getResourceDeclaration } from "./declaration.ts";

/** Minimal state view the hasher needs to resolve managed reference ids. */
export interface HashStateLookup {
	getResource(address: ResourceAddress): Pick<ResourceState, "remote_id"> | undefined;
}

export async function computeResourceHash(
	address: ResourceAddress,
	config: ProjectConfig,
	basePath?: string,
	state?: HashStateLookup,
): Promise<string> {
	const decl = getDeclaration(address, config);
	if (!decl) return "";

	if (address.type === "skill") {
		const skillDecl = decl as { source: string };
		if (basePath) {
			const fileHash = computeSkillContentHash(skillDecl.source, basePath);
			return contentHash({ decl, fileHash });
		}
	}

	if (address.type === "deployment") {
		const refs = resolveDeploymentReferenceIds(decl as DeploymentRefDecl, config, address.provider, state);
		if (refs) return contentHash({ decl, refs });
	}

	if (address.type === "template") {
		const refs = resolveTemplateReferenceIds(decl as TemplateRefDecl, config, address.provider, state);
		return contentHash({ decl, refs });
	}

	if (address.type === "channel") {
		const refs = resolveChannelReferenceIds(
			decl as { agent: string; identity?: string },
			config,
			address.provider,
			state,
		);
		return contentHash({ decl, refs });
	}

	return contentHash(decl);
}

function resolveChannelReferenceIds(
	decl: { agent: string; identity?: string },
	config: ProjectConfig,
	provider: string,
	state?: HashStateLookup,
): Record<string, string | null | undefined> {
	const agent = config.agents?.[decl.agent];
	const agentType = agent?.delivery?.[provider]?.type === "forward" ? "template" : "agent";
	const identity = decl.identity ?? config.defaults?.identity;
	return {
		agent_id: state?.getResource({ type: agentType, name: decl.agent, provider })?.remote_id,
		identity_id: identity ? state?.getResource({ type: "identity", name: identity, provider })?.remote_id : undefined,
	};
}

interface DeploymentRefDecl {
	agent: string;
	environment?: string;
}

interface TemplateRefDecl {
	environment?: string;
	tunnel?: string;
	vault?: string;
	skills?: Array<string | { type: "official" | "custom"; skill_id: string; version?: string }>;
}

function resolveTemplateReferenceIds(
	decl: TemplateRefDecl,
	config: ProjectConfig,
	provider: string,
	state?: HashStateLookup,
): Record<string, unknown> {
	const environment = decl.environment ? config.environments?.[decl.environment] : undefined;
	const tunnel = decl.tunnel ? config.tunnels?.[decl.tunnel] : undefined;
	const skillIds = (decl.skills ?? []).map((skill) => {
		if (typeof skill === "string") {
			return state?.getResource({ type: "skill", name: skill, provider })?.remote_id ?? skill;
		}
		if (skill.type === "official") return `${skill.type}:${skill.skill_id}:${skill.version ?? ""}`;
		return (
			state?.getResource({ type: "skill", name: skill.skill_id, provider })?.remote_id ??
			`${skill.type}:${skill.skill_id}:${skill.version ?? ""}`
		);
	});
	return {
		environment_id:
			environment?.environment_id ??
			(decl.environment
				? (state?.getResource({ type: "environment", name: decl.environment, provider })?.remote_id ?? undefined)
				: undefined),
		tunnel_id: tunnel?.tunnel_id,
		vault_ids: decl.vault
			? [state?.getResource({ type: "vault", name: decl.vault, provider })?.remote_id ?? decl.vault]
			: [],
		skill_ids: skillIds,
	};
}

// A deployment's identity includes the *resolved* ids of its reference-type
// inputs that actually reach the wire (the environment id). Those values can
// change while the referenced names stay the same, and a name-only hash would
// never produce an update for the new id. Best-effort: ids that only exist
// after an apply (managed environment remote ids) resolve via state when
// available and stay undefined until then — they are stable once created, so
// no false diffs. The tunnel id is excluded on purpose: Qoder's deployment API
// does not accept tunnel_id, so a changed value would trigger no-op updates.
function resolveDeploymentReferenceIds(
	decl: DeploymentRefDecl,
	config: ProjectConfig,
	provider: string,
	state?: HashStateLookup,
): Record<string, string | undefined> | undefined {
	const agent = config.agents?.[decl.agent];
	const envName = decl.environment ?? agent?.environment;
	if (!envName) return undefined;

	const envDecl = config.environments?.[envName];
	return {
		environment_id:
			envDecl?.environment_id ??
			(envDecl
				? (state?.getResource({ type: "environment", name: envName, provider })?.remote_id ?? undefined)
				: undefined),
	};
}

function getDeclaration(address: ResourceAddress, config: ProjectConfig): unknown | null {
	return getResourceDeclaration(address, config);
}

export function computeSkillContentHash(source: string, basePath: string): string {
	const fullPath = resolve(dirname(basePath), source);
	const stat = statSync(fullPath, { throwIfNoEntry: false });

	if (stat?.isDirectory()) {
		const parts = collectFiles(fullPath, "").map((file) => `${file.relativePath}:${file.content.toString("utf-8")}`);
		return contentHash(parts.join("\n"));
	}

	if (stat?.isFile()) {
		// For .zip files, hash the binary content directly
		if (fullPath.endsWith(".zip")) {
			const content = readFileSync(fullPath);
			return contentHash(content.toString("base64"));
		}
		const content = readFileSync(fullPath, "utf-8");
		return contentHash(content);
	}

	return "";
}

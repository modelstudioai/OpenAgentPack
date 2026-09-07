import { artifactDisplayName } from "@/lib/artifact-file-name";
import type { SessionDetail } from "@/lib/project-api";
import type { ArtifactKind, DocumentMimeType } from "@/lib/view/artifact";
import {
	buildToolChainRows,
	extractInvokedSkillName,
	extractToolName,
	type RunTimelineItem,
} from "@/lib/view/run-timeline";

export interface PreviewArtifactEntry {
	id: string;
	title: string;
	kind: ArtifactKind | "delivered_file" | "document";
	timelineKey: string;
	url?: string;
	fileId?: string;
	mimeType?: DocumentMimeType;
}

export interface PreviewCapabilityEntry {
	id: string;
	kind: "tool" | "skill" | "mcp";
	name: string;
	configured: boolean;
	count: number;
	timelineKey?: string;
	version?: string;
}

type SessionAgentDetails = SessionDetail["agent_details"];

export function previewAgentModel(agent: SessionAgentDetails): string | undefined {
	const model = agent.model;
	if (typeof model === "string") return model;
	if (!model || typeof model !== "object") return undefined;
	const id = (model as Record<string, unknown>).id;
	return typeof id === "string" ? id : undefined;
}

export function buildPreviewArtifacts(timelineItems: RunTimelineItem[]): PreviewArtifactEntry[] {
	const entries: PreviewArtifactEntry[] = [];
	const seen = new Set<string>();
	for (const item of timelineItems) {
		if (item.kind !== "artifact") continue;
		for (const [segmentIndex, segment] of item.segments.entries()) {
			if (segment.type === "images") {
				for (const [artifactIndex, artifact] of segment.artifacts.entries()) {
					pushArtifact(
						entries,
						seen,
						{
							id: `url:${artifact.url}`,
							title: artifactDisplayName(artifact.url, artifact.title),
							kind: artifact.kind,
							timelineKey: item.key,
							url: artifact.url,
						},
						`${item.key}:${segmentIndex}:${artifactIndex}`,
					);
				}
				continue;
			}
			if (segment.type === "artifact") {
				pushArtifact(
					entries,
					seen,
					{
						id: `url:${segment.artifact.url}`,
						title: artifactDisplayName(segment.artifact.url, segment.artifact.title),
						kind: segment.artifact.kind,
						timelineKey: item.key,
						url: segment.artifact.url,
					},
					`${item.key}:${segmentIndex}`,
				);
				continue;
			}
			if (segment.type === "delivered_file") {
				pushArtifact(
					entries,
					seen,
					{
						id: `file:${segment.file.file_id}`,
						title: segment.file.filename,
						kind: "delivered_file",
						timelineKey: item.key,
						fileId: segment.file.file_id,
					},
					`${item.key}:${segmentIndex}`,
				);
				continue;
			}
			if (segment.type === "document") {
				pushArtifact(
					entries,
					seen,
					{
						id: `document:${item.key}:${segmentIndex}`,
						title: segment.title?.trim() || documentFallbackTitle(segment.mimeType),
						kind: "document",
						timelineKey: item.key,
						mimeType: segment.mimeType,
					},
					`${item.key}:${segmentIndex}`,
				);
			}
		}
	}
	return entries;
}

export function buildPreviewCapabilities(
	agent: SessionAgentDetails,
	timelineItems: RunTimelineItem[],
): PreviewCapabilityEntry[] {
	const entries = new Map<string, PreviewCapabilityEntry>();
	for (const name of configuredToolNames(agent.tools)) addConfigured(entries, "tool", name);
	for (const skill of agent.skills) {
		addConfigured(entries, "skill", skill.id, skill.version);
	}
	for (const serverName of agent.mcpServers) addConfigured(entries, "mcp", serverName);

	for (const item of timelineItems) {
		if (item.kind !== "tool_chain") continue;
		for (const row of buildToolChainRows(item.events)) {
			if (row.kind !== "action") continue;
			const toolName = extractToolName(row.event);
			if (toolName) addInvocation(entries, "tool", toolName, item.key);
			const skillName = extractInvokedSkillName(row.event);
			if (skillName) addInvocation(entries, "skill", skillName, item.key);
		}
	}

	return Array.from(entries.values()).sort((left, right) => {
		const kindOrder = { tool: 0, skill: 1, mcp: 2 } as const;
		return kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name);
	});
}

function configuredToolNames(tools: unknown): string[] {
	if (!tools || typeof tools !== "object" || Array.isArray(tools)) return [];
	const builtin = (tools as Record<string, unknown>).builtin;
	if (!Array.isArray(builtin)) return [];
	return Array.from(
		new Set(
			builtin
				.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
				.map((name) => name.trim()),
		),
	);
}

function addConfigured(
	entries: Map<string, PreviewCapabilityEntry>,
	kind: PreviewCapabilityEntry["kind"],
	name: string,
	version?: string,
): void {
	const trimmedName = name.trim();
	if (!trimmedName) return;
	const id = capabilityId(kind, trimmedName);
	const current = entries.get(id);
	entries.set(id, {
		id,
		kind,
		name: trimmedName,
		configured: true,
		count: current?.count ?? 0,
		timelineKey: current?.timelineKey,
		version: version ?? current?.version,
	});
}

function addInvocation(
	entries: Map<string, PreviewCapabilityEntry>,
	kind: PreviewCapabilityEntry["kind"],
	name: string,
	timelineKey: string,
): void {
	const trimmedName = name.trim();
	if (!trimmedName) return;
	const id = capabilityId(kind, trimmedName);
	const current = entries.get(id);
	entries.set(id, {
		id,
		kind,
		name: current?.name ?? trimmedName,
		configured: current?.configured ?? false,
		count: (current?.count ?? 0) + 1,
		timelineKey,
		version: current?.version,
	});
}

function capabilityId(kind: PreviewCapabilityEntry["kind"], name: string): string {
	return `${kind}:${name.toLocaleLowerCase()}`;
}

function pushArtifact(
	entries: PreviewArtifactEntry[],
	seen: Set<string>,
	entry: PreviewArtifactEntry,
	fallbackId: string,
): void {
	const id = entry.id || fallbackId;
	if (seen.has(id)) return;
	seen.add(id);
	entries.push({ ...entry, id });
}

function documentFallbackTitle(mimeType: DocumentMimeType): string {
	if (mimeType === "image/svg+xml") return "SVG 产物";
	if (mimeType === "text/mermaid") return "Mermaid 图表";
	return "HTML 产物";
}

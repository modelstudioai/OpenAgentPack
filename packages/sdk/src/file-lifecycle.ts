// Provider file lifecycle: the single source of truth for upload defaults, wire-status
// normalization, bindability (`available`), and poll policy — shared across SDK adapters,
// the server, and both webui transports. Pure (no I/O), safe for browser bundles via
// `@openagentpack/sdk/file-lifecycle`.

import type { ProviderFileInfo } from "./internal/types/file.ts";
import { classifyFileScan } from "./scan-lifecycle.ts";

/** Neutral file scan status after provider wire normalization. */
export type NeutralFileStatus = "available" | "checking" | "rejected" | "type_rejected";

/** Upload + bindability metadata enriched onto a provider file record. */
export type EnrichedFileMetadata = {
	status?: NeutralFileStatus;
	/** Whether the file can be selected and bound to a session. */
	available: boolean;
	/** Whether the UI should poll GET /files/{id} until bindable or terminal. */
	needs_poll: boolean;
};

type FileWire = Pick<ProviderFileInfo, "status" | "downloadable">;

interface FileProviderProfile {
	/** Default multipart `purpose` when the caller omits one. */
	defaultUploadPurpose?: string;
	/** Map provider-native status strings to the neutral scan vocabulary. */
	normalizeStatus: (raw: string | undefined) => NeutralFileStatus | undefined;
	/** Derive bindability when wire status is absent (e.g. OpenAPI list omits status). */
	bindableWithoutStatus: (downloadable?: boolean) => boolean;
	/** Foreground poll until audit completes (only bailian today). */
	needsStatusPoll: boolean;
}

const BAILIAN_PROFILE: FileProviderProfile = {
	normalizeStatus(raw) {
		const s = raw?.toLowerCase();
		if (s === "available" || s === "checking" || s === "rejected" || s === "type_rejected") return s;
		return undefined;
	},
	bindableWithoutStatus(downloadable) {
		// OpenAPI list omits status but sets downloadable=true only when available.
		return downloadable === true;
	},
	needsStatusPoll: true,
};

const PROFILES: Record<string, FileProviderProfile> = {
	bailian: BAILIAN_PROFILE,
	qoder: {
		defaultUploadPurpose: "session_resource",
		normalizeStatus(raw) {
			const s = raw?.toLowerCase();
			if (s === "ready" || s === "available") return "available";
			if (s === "checking") return "checking";
			if (s === "rejected" || s === "type_rejected") return s;
			// Qoder session uploads are bindable as soon as POST /files succeeds.
			return "available";
		},
		bindableWithoutStatus() {
			return true;
		},
		needsStatusPoll: false,
	},
	ark: {
		defaultUploadPurpose: "agent",
		normalizeStatus() {
			return "available";
		},
		bindableWithoutStatus() {
			return true;
		},
		needsStatusPoll: false,
	},
	claude: {
		normalizeStatus(raw) {
			const s = raw?.toLowerCase();
			if (s === "available" || s === "checking" || s === "rejected" || s === "type_rejected") return s;
			return "available";
		},
		bindableWithoutStatus(downloadable) {
			return downloadable !== false;
		},
		needsStatusPoll: false,
	},
};

function profile(provider: string): FileProviderProfile {
	return PROFILES[provider] ?? BAILIAN_PROFILE;
}

/** Default `purpose` for multipart file uploads on this provider (undefined = omit). */
export function defaultFileUploadPurpose(provider: string): string | undefined {
	return profile(provider).defaultUploadPurpose;
}

/** Whether the UI should poll file status after upload/list. */
export function needsFileStatusPoll(provider: string): boolean {
	return profile(provider).needsStatusPoll;
}

/** Normalize a provider-native status string to the neutral scan vocabulary. */
export function normalizeWireFileStatus(provider: string, raw: string | undefined): NeutralFileStatus | undefined {
	return profile(provider).normalizeStatus(raw);
}

/**
 * Derive bindability + normalized status from raw provider metadata.
 * All provider branching lives here — consumers must not re-derive `available`.
 */
export function enrichFileMetadata(provider: string, wire: FileWire): EnrichedFileMetadata {
	const status = profile(provider).normalizeStatus(wire.status);
	const available =
		status !== undefined
			? classifyFileScan(status) === "ready"
			: profile(provider).bindableWithoutStatus(wire.downloadable);
	const needs_poll =
		profile(provider).needsStatusPoll && !available && (status === undefined || classifyFileScan(status) === "pending");
	return { status, available, needs_poll };
}

/** Apply enrichment onto a full ProviderFileInfo record (server + UI boundary). */
export function enrichProviderFileInfo(
	provider: string,
	info: ProviderFileInfo,
): ProviderFileInfo & { available: boolean } {
	const meta = enrichFileMetadata(provider, info);
	return { ...info, status: meta.status, available: meta.available };
}

import {
	AlertTriangle,
	Braces,
	CheckCircle2,
	Code2,
	Edit3,
	Eye,
	FileText,
	KeyRound,
	LoaderCircle,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type DeclarationPatchOperation,
	type DeclarationPreview,
	type DeclarationType,
	deleteDeclaration,
	listProjectDeclarations,
	type ProjectDeclaration,
	type ProjectPlan,
	planProject,
	previewDeclaration,
	updateDeclaration,
} from "@/lib/project-api";
import { buildYamlLineDiff } from "@/resources/yaml-diff";

interface ResourcesPanelProps {
	projectRevision?: string;
	projectValid: boolean;
	selectedAgentId: string;
	writeBlockedReason?: string;
	onCommitted(
		change: { type: DeclarationType; id: string; action: EditorAction },
		baselinePlan?: ProjectPlan,
	): Promise<void>;
}

type EditorAction = "edit" | "delete";
type FieldKind = "text" | "textarea" | "json" | "string-or-json" | "credentials";

interface FieldDefinition {
	name: string;
	label: string;
	kind: FieldKind;
	required?: boolean;
	placeholder?: string;
}

const TYPE_LABELS: Record<DeclarationType, string> = {
	agent: "Agents",
	environment: "Environments",
	skill: "Skills",
	vault: "Vaults",
	memory_store: "Memory Stores",
	file: "Files",
};

const TYPE_DESCRIPTIONS: Record<DeclarationType, string> = {
	agent: "Remote Agent definitions and their runtime bindings",
	environment: "Managed or externally owned execution environments",
	skill: "Skill packages referenced by Agents",
	vault: "Credential collections; existing secrets remain redacted",
	memory_store: "Memory definitions and inline entries",
	file: "Declared source files; removing a declaration keeps the local file",
};

const FIELD_DEFINITIONS: Record<DeclarationType, FieldDefinition[]> = {
	agent: [
		{ name: "name", label: "Display name", kind: "text" },
		{ name: "description", label: "Description", kind: "textarea" },
		{ name: "model", label: "Model", kind: "string-or-json", required: true },
		{ name: "instructions", label: "Instructions", kind: "textarea", required: true },
		{ name: "environment", label: "Environment", kind: "text" },
		{ name: "tunnel", label: "Tunnel", kind: "text" },
		{ name: "provider", label: "Provider", kind: "text" },
		{ name: "tools", label: "Tools", kind: "json" },
		{ name: "mcp_servers", label: "MCP servers", kind: "json" },
		{ name: "skills", label: "Skills", kind: "json" },
		{ name: "vault", label: "Vault", kind: "text" },
		{ name: "memory_stores", label: "Memory stores", kind: "json" },
		{ name: "resources", label: "Runtime resources", kind: "json" },
		{ name: "multiagent", label: "Multi-Agent configuration", kind: "json" },
		{ name: "metadata", label: "Metadata", kind: "json" },
		{ name: "environment_variables", label: "Environment variables", kind: "json" },
		{ name: "delivery", label: "Delivery", kind: "json" },
	],
	environment: [
		{ name: "name", label: "Display name", kind: "text" },
		{ name: "description", label: "Description", kind: "textarea" },
		{ name: "provider", label: "Provider", kind: "text" },
		{ name: "config", label: "Environment config", kind: "json", required: true },
		{ name: "metadata", label: "Metadata", kind: "json" },
	],
	skill: [
		{ name: "name", label: "Display name", kind: "text" },
		{ name: "source", label: "Source", kind: "text", required: true },
		{ name: "description", label: "Description", kind: "textarea" },
		{ name: "version", label: "Version", kind: "text" },
		{ name: "origin", label: "Origin", kind: "text" },
		{ name: "provider", label: "Provider", kind: "text" },
	],
	vault: [
		{ name: "display_name", label: "Display name", kind: "text", required: true },
		{ name: "provider", label: "Provider", kind: "text" },
		{ name: "credentials", label: "Credentials", kind: "credentials", required: true },
		{ name: "metadata", label: "Metadata", kind: "json" },
	],
	memory_store: [
		{ name: "description", label: "Description", kind: "textarea", required: true },
		{ name: "provider", label: "Provider", kind: "text" },
		{ name: "metadata", label: "Metadata", kind: "json" },
		{ name: "entries", label: "Memory entries", kind: "json" },
	],
	file: [
		{ name: "source", label: "Source", kind: "text", required: true },
		{ name: "name", label: "Display name", kind: "text" },
		{ name: "purpose", label: "Purpose", kind: "text" },
		{ name: "provider", label: "Provider", kind: "text" },
	],
};

const TYPE_ICONS: Record<DeclarationType, typeof Braces> = {
	agent: Braces,
	environment: Code2,
	skill: FileText,
	vault: KeyRound,
	memory_store: Braces,
	file: FileText,
};

export function ResourcesPanel({
	projectRevision,
	projectValid,
	selectedAgentId,
	writeBlockedReason,
	onCommitted,
}: ResourcesPanelProps) {
	const [resources, setResources] = useState<ProjectDeclaration[]>([]);
	const [revision, setRevision] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [editor, setEditor] = useState<{ resource: ProjectDeclaration; action: EditorAction }>();

	useEffect(() => {
		if (!projectValid || !projectRevision) {
			setLoading(false);
			setResources([]);
			return;
		}
		let active = true;
		setLoading(true);
		void listProjectDeclarations()
			.then((result) => {
				if (!active) return;
				setResources(result.resources);
				setRevision(result.revision);
				setError(undefined);
			})
			.catch((caught) => {
				if (active) setError(errorMessage(caught));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [projectRevision, projectValid]);

	const visibleResources = useMemo(() => {
		return resources.filter(
			(resource) =>
				(resource.type === "agent" && resource.id === selectedAgentId) ||
				resource.references.some((reference) => reference.type === "agent" && reference.id === selectedAgentId),
		);
	}, [resources, selectedAgentId]);

	const grouped = useMemo(
		() =>
			(Object.keys(TYPE_LABELS) as DeclarationType[]).map((type) => ({
				type,
				resources: visibleResources.filter((resource) => resource.type === type),
			})),
		[visibleResources],
	);

	return (
		<section className="resources-panel panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>{selectedAgentId} resources</h2>
					<p>
						Edit this Agent and the declarations it references in agents.yaml. New declarations are intentionally
						unavailable.
					</p>
				</div>
			</div>
			{error && <InlineNotice tone="error">{error}</InlineNotice>}
			{writeBlockedReason && <InlineNotice tone="info">{writeBlockedReason}</InlineNotice>}
			{loading ? (
				<div className="empty-panel">
					<LoaderCircle className="spin" />
					<p>Reading declarations from agents.yaml…</p>
				</div>
			) : (
				<div className="resource-groups">
					{grouped.map(({ type, resources: typeResources }) => {
						const Icon = TYPE_ICONS[type];
						return (
							<section className="resource-group" key={type}>
								<header>
									<div className="resource-group-title">
										<Icon />
										<span>
											<strong>{TYPE_LABELS[type]}</strong>
											<small>{TYPE_DESCRIPTIONS[type]}</small>
										</span>
									</div>
									<b>{typeResources.length}</b>
								</header>
								<div className="resource-declaration-list">
									{typeResources.map((resource) => (
										<div className="resource-declaration-row" key={`${resource.type}:${resource.id}`}>
											<div>
												<strong>{resource.id}</strong>
												<small>{resourceSummary(resource)}</small>
											</div>
											<span className="reference-count">
												{resource.references.length} reference{resource.references.length === 1 ? "" : "s"}
											</span>
											<button
												type="button"
												className="row-edit-button"
												disabled={!projectValid}
												onClick={() => setEditor({ resource, action: "edit" })}
											>
												<Edit3 /> Edit
											</button>
											<button
												type="button"
												className="row-remove-button"
												disabled={!projectValid}
												onClick={() => setEditor({ resource, action: "delete" })}
											>
												<Trash2 /> Remove from agents.yaml
											</button>
										</div>
									))}
									{typeResources.length === 0 && <p className="resource-empty-row">No declared {TYPE_LABELS[type]}.</p>}
								</div>
							</section>
						);
					})}
				</div>
			)}
			{editor && (
				<DeclarationEditor
					key={`${editor.action}:${editor.resource.type}:${editor.resource.id}:${revision}`}
					resource={editor.resource}
					revision={revision}
					action={editor.action}
					writeBlockedReason={writeBlockedReason}
					onClose={() => setEditor(undefined)}
					onCommitted={onCommitted}
				/>
			)}
		</section>
	);
}

function DeclarationEditor({
	resource,
	revision,
	action,
	writeBlockedReason,
	onClose,
	onCommitted,
}: {
	resource: ProjectDeclaration;
	revision: string;
	action: EditorAction;
	writeBlockedReason?: string;
	onClose(): void;
	onCommitted(
		change: { type: DeclarationType; id: string; action: EditorAction },
		baselinePlan?: ProjectPlan,
	): Promise<void>;
}) {
	const fields = FIELD_DEFINITIONS[resource.type];
	const [enabledFields, setEnabledFields] = useState(
		() =>
			new Set(
				fields.filter((field) => field.required || field.name in resource.declaration).map((field) => field.name),
			),
	);
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((field) => [field.name, fieldText(resource.declaration[field.name], field.kind)])),
	);
	const [secretReplacements, setSecretReplacements] = useState<Record<string, string>>({});
	const [preview, setPreview] = useState<DeclarationPreview>();
	const [previewSignature, setPreviewSignature] = useState("");
	const [localError, setLocalError] = useState<string>();
	const [busy, setBusy] = useState(false);

	const currentSignature = useMemo(
		() => JSON.stringify({ action, enabled: [...enabledFields].sort(), values, secretReplacements }),
		[action, enabledFields, secretReplacements, values],
	);
	const previewIsCurrent = previewSignature === currentSignature;
	const credentials = useMemo(() => parseCredentialDraft(values.credentials), [values.credentials]);

	const buildOperations = (): DeclarationPatchOperation[] => {
		const operations: DeclarationPatchOperation[] = [];
		for (const field of fields) {
			const existed = field.name in resource.declaration;
			if (!enabledFields.has(field.name)) {
				if (existed) operations.push({ op: "remove", path: [field.name] });
				continue;
			}
			const value = parseFieldValue(values[field.name] ?? "", field);
			const withSecrets = field.kind === "credentials" ? applySecretReplacements(value, secretReplacements) : value;
			if (!existed || !deepEqual(withSecrets, resource.declaration[field.name])) {
				operations.push({ op: "set", path: [field.name], value: withSecrets });
			}
		}
		if (operations.length === 0) throw new Error("Change at least one field before previewing this edit.");
		return operations;
	};

	const handlePreview = async () => {
		setBusy(true);
		setLocalError(undefined);
		try {
			const operations = action === "edit" ? buildOperations() : [];
			const result = await previewDeclaration(
				resource.type,
				resource.id,
				revision,
				action === "edit" ? "update" : "delete",
				operations,
			);
			setPreview(result);
			setPreviewSignature(currentSignature);
		} catch (caught) {
			setLocalError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};

	const handleCommit = async () => {
		if (!preview?.can_commit || !previewIsCurrent || writeBlockedReason) return;
		setBusy(true);
		setLocalError(undefined);
		try {
			const baselinePlan = await planProject().catch(() => undefined);
			if (action === "delete") {
				await deleteDeclaration(resource.type, resource.id, revision);
			} else {
				await updateDeclaration(resource.type, resource.id, revision, buildOperations());
			}
			onClose();
			await onCommitted({ type: resource.type, id: resource.id, action }, baselinePlan);
		} catch (caught) {
			setLocalError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="declaration-editor-backdrop">
			<button
				type="button"
				className="declaration-editor-dismiss"
				aria-label="Close declaration editor"
				onClick={onClose}
			/>
			<aside
				className="declaration-editor"
				aria-label={`${action === "edit" ? "Edit" : "Remove"} ${resource.type} ${resource.id}`}
			>
				<header className="declaration-editor-header">
					<div>
						<span>{action === "edit" ? "Edit declaration" : "Remove declaration"}</span>
						<h2>{resource.id}</h2>
						<code>{resource.type} · resource key is immutable</code>
					</div>
					<button type="button" onClick={onClose} aria-label="Close declaration editor">
						<X />
					</button>
				</header>

				<div className="declaration-editor-body">
					{action === "edit" ? (
						<div className="declaration-form">
							{resource.type === "environment" && resource.declaration.environment_id !== undefined && (
								<InlineNotice tone="info">
									External environment ownership ({String(resource.declaration.environment_id)}) is read-only.
								</InlineNotice>
							)}
							{fields.map((field) => {
								const readOnlyPaths = resource.read_only_paths.filter((path) => path[0] === field.name);
								const readOnlyPath = readOnlyPaths[0];
								const readOnly = readOnlyPaths.some((path) => path.length === 1);
								const containsReadOnlyContent = readOnlyPaths.length > 0;
								const enabled = enabledFields.has(field.name);
								return (
									<div className={`declaration-field ${!enabled ? "disabled" : ""}`} key={field.name}>
										<label className="declaration-field-heading">
											<input
												type="checkbox"
												checked={enabled}
												disabled={field.required || containsReadOnlyContent}
												onChange={(event) => {
													setEnabledFields((current) => {
														const next = new Set(current);
														if (event.target.checked) next.add(field.name);
														else next.delete(field.name);
														return next;
													});
													setPreview(undefined);
												}}
											/>
											<span>{field.label}</span>
											{field.required && <small>required</small>}
										</label>
										{enabled && (
											<FieldInput
												field={field}
												value={values[field.name] ?? ""}
												readOnly={readOnly}
												onChange={(value) => {
													setValues((current) => ({ ...current, [field.name]: value }));
													setPreview(undefined);
												}}
											/>
										)}
										{containsReadOnlyContent && (
											<small className="field-readonly-note">
												Referenced local content at {readOnlyPath?.join(".")} is read-only in this release.
											</small>
										)}
										{field.kind === "credentials" && enabled && credentials && (
											<CredentialSecretInputs
												credentials={credentials}
												replacements={secretReplacements}
												onChange={(key, value) => {
													setSecretReplacements((current) => ({ ...current, [key]: value }));
													setPreview(undefined);
												}}
											/>
										)}
									</div>
								);
							})}
						</div>
					) : (
						<div className="delete-declaration-copy">
							<AlertTriangle />
							<h3>
								Remove {resource.type}.{resource.id} from agents.yaml?
							</h3>
							<p>
								This only removes the local declaration. Remote deletion happens later through a reviewed project Plan
								and Apply. Local source files are never deleted.
							</p>
						</div>
					)}

					{localError && <InlineNotice tone="error">{localError}</InlineNotice>}

					<div className="preview-toolbar">
						<div>
							<h3>Server preview</h3>
							<p>Preview is required and never writes agents.yaml.</p>
						</div>
						<button type="button" className="secondary-button" disabled={busy} onClick={() => void handlePreview()}>
							{busy ? <LoaderCircle className="spin" /> : <Eye />} Preview YAML Diff
						</button>
					</div>

					{preview && previewIsCurrent ? (
						<PreviewResult preview={preview} />
					) : (
						<div className="preview-placeholder">
							<Code2 />
							<span>
								{preview ? "Fields changed; refresh the preview before saving." : "No preview generated yet."}
							</span>
						</div>
					)}
				</div>

				<footer className="declaration-editor-footer">
					<span>
						{writeBlockedReason
							? "Apply is running; this draft is preserved, but saving is temporarily disabled."
							: "Saving updates agents.yaml only. The next Apply creates its local Git version automatically; push remains manual."}
					</span>
					<div>
						<button type="button" className="secondary-button" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className={action === "delete" ? "danger-button" : "primary-button"}
							disabled={busy || !preview?.can_commit || !previewIsCurrent || Boolean(writeBlockedReason)}
							onClick={() => void handleCommit()}
						>
							{busy ? <LoaderCircle className="spin" /> : action === "delete" ? <Trash2 /> : <CheckCircle2 />}
							{action === "delete" ? "Remove declaration" : "Save agents.yaml"}
						</button>
					</div>
				</footer>
			</aside>
		</div>
	);
}

function FieldInput({
	field,
	value,
	readOnly,
	onChange,
}: {
	field: FieldDefinition;
	value: string;
	readOnly: boolean;
	onChange(value: string): void;
}) {
	if (field.kind === "textarea" || field.kind === "json" || field.kind === "credentials") {
		return (
			<textarea
				rows={field.kind === "textarea" ? 5 : 9}
				value={value}
				readOnly={readOnly}
				spellCheck={field.kind === "textarea"}
				placeholder={field.placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		);
	}
	return (
		<input
			type="text"
			value={value}
			readOnly={readOnly}
			placeholder={field.placeholder}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

function CredentialSecretInputs({
	credentials,
	replacements,
	onChange,
}: {
	credentials: Array<Record<string, unknown>>;
	replacements: Record<string, string>;
	onChange(key: string, value: string): void;
}) {
	return (
		<div className="credential-secret-list">
			<p>Secret replacements</p>
			{credentials.map((credential, index) => {
				const field = credential.type === "static_bearer" ? "access_token" : "secret_value";
				const key = credentialSecretKey(credential, field);
				return (
					<label key={key}>
						<span>
							{String(credential.name ?? `Credential ${index + 1}`)} · {field}
						</span>
						<input
							type="password"
							value={replacements[key] ?? ""}
							placeholder="Stored value unchanged"
							autoComplete="new-password"
							onChange={(event) => onChange(key, event.target.value)}
						/>
					</label>
				);
			})}
		</div>
	);
}

function PreviewResult({ preview }: { preview: DeclarationPreview }) {
	const diff = buildYamlLineDiff(preview.before_yaml, preview.after_yaml);
	return (
		<div className="declaration-preview-result">
			<div className="yaml-unified-diff">
				<div className="yaml-diff-file-header">
					<span>--- agents.yaml · before</span>
					<span>+++ agents.yaml · after</span>
				</div>
				<div className="yaml-diff-hunk">
					@@ -1,{diff.beforeLineCount} +1,{diff.afterLineCount} @@
				</div>
				<div className="yaml-diff-lines">
					{diff.lines.map((line) => (
						<div
							className={`yaml-diff-line ${line.kind}`}
							key={`${line.kind}:${line.beforeLine ?? "new"}:${line.afterLine ?? "old"}:${line.text}`}
						>
							<span className="yaml-diff-line-number">{line.beforeLine ?? ""}</span>
							<span className="yaml-diff-line-number">{line.afterLine ?? ""}</span>
							<span className="yaml-diff-marker">
								{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
							</span>
							<code>{line.text || " "}</code>
						</div>
					))}
				</div>
			</div>
			<div className={`commit-readiness ${preview.can_commit ? "ready" : "blocked"}`}>
				{preview.can_commit ? <CheckCircle2 /> : <AlertTriangle />}
				<span>{preview.can_commit ? "Ready to save agents.yaml" : "Save blocked by validation or references"}</span>
			</div>
			{preview.references.length > 0 && (
				<div className="preview-findings">
					<h4>Blocking references</h4>
					{preview.references.map((reference) => (
						<code key={`${reference.type}:${reference.id}:${reference.path}`}>{reference.path}</code>
					))}
				</div>
			)}
			{preview.diagnostics.length > 0 && (
				<div className="preview-findings">
					<h4>Validation diagnostics</h4>
					{preview.diagnostics.map((diagnostic) => (
						<div
							className={`preview-diagnostic ${diagnostic.severity}`}
							key={`${diagnostic.code}:${diagnostic.message}`}
						>
							<strong>{diagnostic.code}</strong>
							<span>{diagnostic.message}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function InlineNotice({ tone, children }: { tone: "error" | "info"; children: React.ReactNode }) {
	return (
		<div className={`resource-inline-notice ${tone}`}>
			{tone === "error" ? <AlertTriangle /> : <RefreshCw />}
			<span>{children}</span>
		</div>
	);
}

function fieldText(value: unknown, kind: FieldKind): string {
	if (value === undefined) return kind === "json" || kind === "credentials" ? "" : "";
	if (kind === "json" || kind === "credentials") return JSON.stringify(value, null, 2);
	if (kind === "string-or-json" && typeof value !== "string") return JSON.stringify(value, null, 2);
	return String(value);
}

function parseFieldValue(value: string, field: FieldDefinition): unknown {
	if (field.kind === "json" || field.kind === "credentials") {
		if (!value.trim()) throw new Error(`${field.label} must contain valid JSON.`);
		const parsed = JSON.parse(value) as unknown;
		if (field.kind === "credentials") assertNoInlineSensitiveValues(parsed);
		return parsed;
	}
	if (field.kind === "string-or-json") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
	}
	return value;
}

function assertNoInlineSensitiveValues(value: unknown): void {
	if (!Array.isArray(value)) throw new Error("Credentials must be a JSON array.");
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const credential = entry as Record<string, unknown>;
		for (const key of ["access_token", "secret_value"]) {
			const secret = credential[key];
			if (secret !== undefined && secret !== "[redacted]" && !isEnvironmentReference(secret)) {
				throw new Error(`Credential ${index + 1} ${key} must be replaced with the password field below.`);
			}
		}
	}
}

function applySecretReplacements(value: unknown, replacements: Record<string, string>): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
		const credential = { ...(entry as Record<string, unknown>) };
		for (const field of ["access_token", "secret_value"]) {
			const replacement = replacements[credentialSecretKey(credential, field)];
			if (replacement) credential[field] = replacement;
		}
		return credential;
	});
}

function credentialSecretKey(credential: Record<string, unknown>, field: string): string {
	return `${String(credential.type)}:${String(credential.name)}:${field}`;
}

function parseCredentialDraft(value: string): Array<Record<string, unknown>> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is Record<string, unknown> =>
					Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
				)
			: undefined;
	} catch {
		return undefined;
	}
}

function isEnvironmentReference(value: unknown): boolean {
	return typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resourceSummary(resource: ProjectDeclaration): string {
	const declaration = resource.declaration;
	for (const key of ["description", "display_name", "name", "source", "provider"]) {
		if (typeof declaration[key] === "string" && declaration[key]) return declaration[key];
	}
	return `${Object.keys(declaration).length} declared fields`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

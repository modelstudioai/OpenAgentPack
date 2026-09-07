import type { TFunction } from "i18next";
import {
	AlertTriangle,
	Braces,
	CheckCircle2,
	Code2,
	Edit3,
	FileText,
	KeyRound,
	LoaderCircle,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
const AUTO_PREVIEW_DELAY_MS = 350;

interface FieldDefinition {
	name: string;
	labelKey: string;
	kind: FieldKind;
	required?: boolean;
	placeholder?: string;
}

const DECLARATION_TYPES: DeclarationType[] = ["agent", "environment", "skill", "vault", "memory_store", "file"];

const FIELD_DEFINITIONS: Record<DeclarationType, FieldDefinition[]> = {
	agent: [
		{ name: "name", labelKey: "resources.fields.name", kind: "text" },
		{ name: "description", labelKey: "resources.fields.description", kind: "textarea" },
		{ name: "model", labelKey: "resources.fields.model", kind: "string-or-json", required: true },
		{ name: "instructions", labelKey: "resources.fields.instructions", kind: "textarea", required: true },
		{ name: "environment", labelKey: "resources.fields.environment", kind: "text" },
		{ name: "tunnel", labelKey: "resources.fields.tunnel", kind: "text" },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
		{ name: "tools", labelKey: "resources.fields.tools", kind: "json" },
		{ name: "mcp_servers", labelKey: "resources.fields.mcp_servers", kind: "json" },
		{ name: "skills", labelKey: "resources.fields.skills", kind: "json" },
		{ name: "vault", labelKey: "resources.fields.vault", kind: "text" },
		{ name: "memory_stores", labelKey: "resources.fields.memory_stores", kind: "json" },
		{ name: "files", labelKey: "resources.fields.files", kind: "json" },
		{ name: "resources", labelKey: "resources.fields.resources", kind: "json" },
		{ name: "multiagent", labelKey: "resources.fields.multiagent", kind: "json" },
		{ name: "metadata", labelKey: "resources.fields.metadata", kind: "json" },
		{ name: "environment_variables", labelKey: "resources.fields.environment_variables", kind: "json" },
		{ name: "delivery", labelKey: "resources.fields.delivery", kind: "json" },
	],
	environment: [
		{ name: "name", labelKey: "resources.fields.name", kind: "text" },
		{ name: "description", labelKey: "resources.fields.description", kind: "textarea" },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
		{ name: "config", labelKey: "resources.fields.config", kind: "json", required: true },
		{ name: "metadata", labelKey: "resources.fields.metadata", kind: "json" },
	],
	skill: [
		{ name: "name", labelKey: "resources.fields.name", kind: "text" },
		{ name: "source", labelKey: "resources.fields.source", kind: "text", required: true },
		{ name: "content", labelKey: "resources.fields.content", kind: "textarea", required: true },
		{ name: "description", labelKey: "resources.fields.description", kind: "textarea" },
		{ name: "version", labelKey: "resources.fields.version", kind: "text" },
		{ name: "origin", labelKey: "resources.fields.origin", kind: "text" },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
	],
	vault: [
		{ name: "display_name", labelKey: "resources.fields.display_name", kind: "text", required: true },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
		{ name: "credentials", labelKey: "resources.fields.credentials", kind: "credentials", required: true },
		{ name: "metadata", labelKey: "resources.fields.metadata", kind: "json" },
	],
	memory_store: [
		{ name: "description", labelKey: "resources.fields.description", kind: "textarea", required: true },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
		{ name: "metadata", labelKey: "resources.fields.metadata", kind: "json" },
		{ name: "entries", labelKey: "resources.fields.entries", kind: "json" },
	],
	file: [
		{ name: "source", labelKey: "resources.fields.source", kind: "text", required: true },
		{ name: "name", labelKey: "resources.fields.name", kind: "text" },
		{ name: "purpose", labelKey: "resources.fields.purpose", kind: "text" },
		{ name: "provider", labelKey: "resources.fields.provider", kind: "text" },
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
	const { t } = useTranslation();
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
				resource.owner_agent === selectedAgentId ||
				resource.references.some((reference) => reference.type === "agent" && reference.id === selectedAgentId),
		);
	}, [resources, selectedAgentId]);

	const grouped = useMemo(
		() =>
			DECLARATION_TYPES.map((type) => ({
				type,
				resources: visibleResources.filter((resource) => resource.type === type),
			})),
		[visibleResources],
	);

	return (
		<section className="resources-panel panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>{t("resources.title", { agent: selectedAgentId })}</h2>
					<p>{t("resources.description")}</p>
				</div>
			</div>
			{error && <InlineNotice tone="error">{error}</InlineNotice>}
			{writeBlockedReason && <InlineNotice tone="info">{writeBlockedReason}</InlineNotice>}
			{loading ? (
				<div className="empty-panel">
					<LoaderCircle className="spin" />
					<p>{t("resources.loading")}</p>
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
											<strong>{t(`resources.types.${type}`)}</strong>
											<small>{t(`resources.typeDescriptions.${type}`)}</small>
										</span>
									</div>
									<b>{typeResources.length}</b>
								</header>
								<div className="resource-declaration-list">
									{typeResources.map((resource) => (
										<div className="resource-declaration-row" key={`${resource.type}:${resource.id}`}>
											<div>
												<strong>{resource.id}</strong>
												<small>{resourceSummary(t, resource)}</small>
											</div>
											<span className="reference-count">
												{t("resources.references", { count: resource.references.length })}
											</span>
											<button
												type="button"
												className="row-edit-button"
												disabled={!projectValid}
												onClick={() => setEditor({ resource, action: "edit" })}
											>
												<Edit3 /> {t("resources.edit")}
											</button>
											<button
												type="button"
												className="row-remove-button"
												disabled={!projectValid}
												onClick={() => setEditor({ resource, action: "delete" })}
											>
												<Trash2 /> {t("resources.removeFromProject")}
											</button>
										</div>
									))}
									{typeResources.length === 0 && (
										<p className="resource-empty-row">
											{t("resources.noDeclared", { type: t(`resources.types.${type}`) })}
										</p>
									)}
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
	const { t } = useTranslation();
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
	const [previewBusy, setPreviewBusy] = useState(false);
	const [commitBusy, setCommitBusy] = useState(false);
	const previewRequestGenerationRef = useRef(0);

	const currentSignature = useMemo(
		() => JSON.stringify({ action, enabled: [...enabledFields].sort(), values, secretReplacements }),
		[action, enabledFields, secretReplacements, values],
	);
	const previewIsCurrent = previewSignature === currentSignature;
	const credentials = useMemo(() => parseCredentialDraft(values.credentials), [values.credentials]);

	const buildOperations = useCallback((): DeclarationPatchOperation[] => {
		const operations: DeclarationPatchOperation[] = [];
		for (const field of fields) {
			const existed = field.name in resource.declaration;
			if (!enabledFields.has(field.name)) {
				if (existed) operations.push({ op: "remove", path: [field.name] });
				continue;
			}
			const value = parseFieldValue(t, values[field.name] ?? "", field);
			const withSecrets = field.kind === "credentials" ? applySecretReplacements(value, secretReplacements) : value;
			if (!existed || !deepEqual(withSecrets, resource.declaration[field.name])) {
				operations.push({ op: "set", path: [field.name], value: withSecrets });
			}
		}
		return operations;
	}, [enabledFields, fields, resource.declaration, secretReplacements, t, values]);

	const runPreview = useCallback(
		async (signature: string, requestGeneration: number) => {
			setPreviewBusy(true);
			setLocalError(undefined);
			try {
				const operations = action === "edit" ? buildOperations() : [];
				if (action === "edit" && operations.length === 0) {
					if (previewRequestGenerationRef.current !== requestGeneration) return;
					setPreview(undefined);
					setPreviewSignature("");
					return;
				}
				const result = await previewDeclaration(
					resource.type,
					resource.id,
					revision,
					action === "edit" ? "update" : "delete",
					operations,
				);
				if (previewRequestGenerationRef.current !== requestGeneration) return;
				setPreview(result);
				setPreviewSignature(signature);
			} catch (caught) {
				if (previewRequestGenerationRef.current !== requestGeneration) return;
				setPreview(undefined);
				setPreviewSignature("");
				setLocalError(errorMessage(caught));
			} finally {
				if (previewRequestGenerationRef.current === requestGeneration) setPreviewBusy(false);
			}
		},
		[action, buildOperations, resource.id, resource.type, revision],
	);

	useEffect(() => {
		const requestGeneration = ++previewRequestGenerationRef.current;
		const timer = setTimeout(
			() => void runPreview(currentSignature, requestGeneration),
			action === "delete" ? 0 : AUTO_PREVIEW_DELAY_MS,
		);
		return () => {
			clearTimeout(timer);
			if (previewRequestGenerationRef.current === requestGeneration) previewRequestGenerationRef.current++;
		};
	}, [action, currentSignature, runPreview]);

	const handleCommit = async () => {
		if (!preview?.can_commit || !previewIsCurrent || previewBusy || writeBlockedReason) return;
		setCommitBusy(true);
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
			setCommitBusy(false);
		}
	};

	return (
		<div className="declaration-editor-backdrop">
			<button
				type="button"
				className="declaration-editor-dismiss"
				aria-label={t("resources.editor.close")}
				onClick={onClose}
			/>
			<aside
				className="declaration-editor"
				aria-label={`${action === "edit" ? t("resources.editor.edit") : t("resources.editor.remove")} ${resource.type} ${resource.id}`}
			>
				<header className="declaration-editor-header">
					<div>
						<span>{action === "edit" ? t("resources.editor.edit") : t("resources.editor.remove")}</span>
						<h2>{resource.id}</h2>
						<code>{t("resources.editor.immutable", { type: resource.type })}</code>
					</div>
					<button type="button" onClick={onClose} aria-label={t("resources.editor.close")}>
						<X />
					</button>
				</header>

				<div className="declaration-editor-body">
					{action === "edit" ? (
						<div className="declaration-form">
							{resource.type === "environment" && resource.declaration.environment_id !== undefined && (
								<InlineNotice tone="info">
									{t("resources.editor.externalEnvironment", { id: String(resource.declaration.environment_id) })}
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
												}}
											/>
											<span>{t(field.labelKey)}</span>
											{field.required && <small>{t("resources.editor.required")}</small>}
										</label>
										{enabled && (
											<FieldInput
												field={field}
												value={values[field.name] ?? ""}
												readOnly={readOnly}
												onChange={(value) => {
													setValues((current) => ({ ...current, [field.name]: value }));
												}}
											/>
										)}
										{containsReadOnlyContent && (
											<small className="field-readonly-note">
												{t("resources.editor.readOnlyContent", { path: readOnlyPath?.join(".") })}
											</small>
										)}
										{field.kind === "credentials" && enabled && credentials && (
											<CredentialSecretInputs
												credentials={credentials}
												replacements={secretReplacements}
												onChange={(key, value) => {
													setSecretReplacements((current) => ({ ...current, [key]: value }));
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
							<h3>{t("resources.editor.removeQuestion", { type: resource.type, id: resource.id })}</h3>
							<p>{t("resources.editor.removeDescription")}</p>
						</div>
					)}

					{localError && <InlineNotice tone="error">{localError}</InlineNotice>}

					<div className="preview-toolbar">
						<div>
							<h3>{t("resources.editor.serverPreview")}</h3>
							<p>{t("resources.editor.previewDescription")}</p>
						</div>
						<span className={`auto-preview-status ${previewBusy ? "loading" : previewIsCurrent ? "ready" : ""}`}>
							{previewBusy ? <LoaderCircle className="spin" /> : previewIsCurrent ? <CheckCircle2 /> : <RefreshCw />}
							{previewBusy
								? t("resources.editor.previewing")
								: previewIsCurrent
									? t("resources.editor.previewCurrent")
									: t("resources.editor.autoPreview")}
						</span>
					</div>

					{preview && previewIsCurrent ? (
						<PreviewResult preview={preview} />
					) : (
						<div className="preview-placeholder">
							<Code2 />
							<span>
								{previewBusy
									? t("resources.editor.generatingDiff")
									: preview
										? t("resources.editor.fieldsChanged")
										: action === "edit"
											? t("resources.editor.changeField")
											: t("resources.editor.generatingDelete")}
							</span>
						</div>
					)}
				</div>

				<footer className="declaration-editor-footer">
					<span>{writeBlockedReason ? t("resources.editor.publishDraft") : t("resources.editor.saveDescription")}</span>
					<div>
						<button type="button" className="secondary-button" onClick={onClose}>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							className={action === "delete" ? "danger-button" : "primary-button"}
							disabled={
								previewBusy || commitBusy || !preview?.can_commit || !previewIsCurrent || Boolean(writeBlockedReason)
							}
							onClick={() => void handleCommit()}
						>
							{commitBusy ? <LoaderCircle className="spin" /> : action === "delete" ? <Trash2 /> : <CheckCircle2 />}
							{action === "delete" ? t("resources.editor.remove") : t("resources.editor.saveFiles")}
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
	const { t } = useTranslation();
	return (
		<div className="credential-secret-list">
			<p>{t("resources.editor.secretReplacements")}</p>
			{credentials.map((credential, index) => {
				const field = credential.type === "static_bearer" ? "access_token" : "secret_value";
				const key = credentialSecretKey(credential, field);
				return (
					<label key={key}>
						<span>
							{String(credential.name ?? t("resources.editor.credential", { number: index + 1 }))} · {field}
						</span>
						<input
							type="password"
							value={replacements[key] ?? ""}
							placeholder={t("resources.editor.storedUnchanged")}
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
	const { t } = useTranslation();
	const diff = buildYamlLineDiff(preview.before_yaml, preview.after_yaml);
	return (
		<div className="declaration-preview-result">
			<div className="yaml-unified-diff">
				<div className="yaml-diff-file-header">
					<span>--- {t("resources.editor.before")}</span>
					<span>+++ {t("resources.editor.after")}</span>
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
				<span>{preview.can_commit ? t("resources.editor.readyToSave") : t("resources.editor.saveBlocked")}</span>
			</div>
			{preview.references.length > 0 && (
				<div className="preview-findings">
					<h4>{t("resources.editor.blockingReferences")}</h4>
					{preview.references.map((reference) => (
						<code key={`${reference.type}:${reference.id}:${reference.path}`}>{reference.path}</code>
					))}
				</div>
			)}
			{preview.diagnostics.length > 0 && (
				<div className="preview-findings">
					<h4>{t("resources.editor.validationDiagnostics")}</h4>
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

function parseFieldValue(t: TFunction, value: string, field: FieldDefinition): unknown {
	if (field.kind === "json" || field.kind === "credentials") {
		if (!value.trim()) throw new Error(t("resources.editor.validJson", { field: t(field.labelKey) }));
		let parsed: unknown;
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			throw new Error(t("resources.editor.validJson", { field: t(field.labelKey) }));
		}
		if (field.kind === "credentials") assertNoInlineSensitiveValues(t, parsed);
		return parsed;
	}
	if (field.kind === "string-or-json") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return JSON.parse(trimmed) as unknown;
			} catch {
				throw new Error(t("resources.editor.validJson", { field: t(field.labelKey) }));
			}
		}
	}
	return value;
}

function assertNoInlineSensitiveValues(t: TFunction, value: unknown): void {
	if (!Array.isArray(value)) throw new Error(t("resources.editor.credentialsArray"));
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const credential = entry as Record<string, unknown>;
		for (const key of ["access_token", "secret_value"]) {
			const secret = credential[key];
			if (secret !== undefined && secret !== "[redacted]" && !isEnvironmentReference(secret)) {
				throw new Error(t("resources.editor.credentialSecret", { number: index + 1, field: key }));
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

function resourceSummary(t: TFunction, resource: ProjectDeclaration): string {
	const declaration = resource.declaration;
	for (const key of ["description", "display_name", "name", "source", "provider"]) {
		if (typeof declaration[key] === "string" && declaration[key]) return declaration[key];
	}
	return t("resources.editor.declaredFields", { count: Object.keys(declaration).length });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

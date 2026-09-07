import { expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const resourcesSource = await Bun.file(new URL("../src/resources/ResourcesPanel.tsx", import.meta.url)).text();
const versionsSource = await Bun.file(new URL("../src/versions/VersionsPanel.tsx", import.meta.url)).text();
const sourceFileDiffSource = await Bun.file(new URL("../src/versions/SourceFileDiff.tsx", import.meta.url)).text();
const translationSource = await Bun.file(new URL("../src/i18n/resources.ts", import.meta.url)).text();
const documentSource = await Bun.file(new URL("../index.html", import.meta.url)).text();
const sessionPreviewSource = await Bun.file(
	new URL("../src/session-preview/SessionPreviewPage.tsx", import.meta.url),
).text();

test("Workbench user-facing branding uses Managed Agents", () => {
	expect(appSource).toContain("<span>Managed Agents</span>");
	expect(documentSource).toContain("<title>Managed Agents Workbench</title>");
	expect(sessionPreviewSource).toContain("Managed Agents Preview");
	expect(appSource).not.toContain("<span>OpenAgentPack</span>");
	expect(documentSource).not.toContain("OpenAgentPack Playground");
	expect(sessionPreviewSource).not.toContain("OpenAgentPack Preview");
});

test("project workbench is directory-driven with no Playbook or runtime model/provider override", () => {
	expect(appSource).toContain('type WorkbenchTab = "overview" | "changes" | "versions" | "debug" | "artifacts"');
	expect(appSource).toContain("planProject(");
	expect(appSource).toContain("applyProject(");
	expect(appSource).toContain("projectEventSource(");
	expect(appSource).toContain('addEventListener("project.snapshot"');
	expect(appSource).toContain("projectRequestGenerationRef");
	expect(appSource).not.toContain("@/lib/playbooks");
	expect(appSource).not.toContain("SettingsDialog");
	expect(appSource).not.toContain("ModelSelector");
	expect(appSource).not.toContain("ProviderSelect");
});

test("Versions is project-scoped, explicitly enabled, automatic after Publish, and supports redacted restore", () => {
	expect(appSource).toContain('{tab === "versions" && (');
	expect(translationSource).toContain("This Publish will not record a directory snapshot");
	expect(appSource).not.toContain("initializeProjectVersioning");
	expect(appSource).toContain('addEventListener("project.mutation"');
	expect(translationSource).toContain("Enable Local Versions");
	expect(translationSource).toContain("Workbench and CLI share one project versioning switch");
	expect(translationSource).toContain("Successful Publish creates a directory snapshot.");
	expect(versionsSource).toContain("setProjectVersioning(projectRevision, !versioning.enabled)");
	expect(versionsSource).not.toContain("Create Version");
	expect(translationSource).toContain("Restore to working tree");
	expect(versionsSource).toContain("selected.version_id === currentVersion");
	expect(translationSource).toContain("Latest version baseline");
	expect(versionsSource).toContain("selected.version_id === versioning?.head_version");
	expect(versionsSource).toContain('direction="restore"');
	expect(sourceFileDiffSource).toContain('type VersionFileChange = ProjectVersionPreview["changes"][number]');
	expect(versionsSource).toContain("previewRequestGenerationRef");
	expect(versionsSource).toContain("preview.base_revision, preview.base_head_version");
	expect(translationSource).toContain("Git is not required");
	expect(versionsSource).not.toContain("git push");
});

test("Publish mutation state blocks source/version writes while preserving resource drafts", () => {
	expect(appSource).toContain("writeBlockedReason={writeBlockedReason}");
	expect(translationSource).toContain("this draft is preserved, but saving is temporarily disabled");
	expect(resourcesSource).toContain("Boolean(writeBlockedReason)");
	expect(versionsSource).toContain("Boolean(writeBlockedReason)");
});

test("resource declarations require Preview before save and expose no create action", () => {
	expect(resourcesSource).toContain("previewDeclaration(");
	expect(resourcesSource).toContain("updateDeclaration(");
	expect(resourcesSource).toContain("deleteDeclaration(");
	expect(translationSource).toContain("Remove from project");
	expect(resourcesSource).toContain("!preview?.can_commit || !previewIsCurrent");
	expect(resourcesSource).not.toContain("Add Agent");
	expect(resourcesSource).not.toContain("Add Resource");
	expect(appSource).toContain("deletedSelectedAgent");
	expect(appSource).toContain("preserveEmptySelection");
});

test("resource preview renders a Git-style red and green unified diff", () => {
	expect(resourcesSource).toContain("buildYamlLineDiff(preview.before_yaml, preview.after_yaml)");
	expect(resourcesSource).toContain("yaml-unified-diff");
	expect(resourcesSource).toContain('line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "');
	expect(resourcesSource).not.toContain('className="yaml-diff-grid"');
});

test("resource preview runs automatically with debounce and stale-response protection", () => {
	expect(resourcesSource).toContain("AUTO_PREVIEW_DELAY_MS");
	expect(resourcesSource).toContain("previewRequestGenerationRef");
	expect(resourcesSource).toContain("void runPreview(currentSignature, requestGeneration)");
	expect(translationSource).toContain("Preview updates automatically after you pause editing");
	expect(resourcesSource).not.toContain("Preview YAML Diff");
});

test("Changes automatically previews Build without a manual preview button", () => {
	expect(appSource).toContain("buildPreviewRequestGenerationRef");
	expect(appSource).toContain('tab !== "changes"');
	expect(appSource).toContain("void loadBuildPreview(project.revision)");
	expect(translationSource).toContain("Ready to publish");
	expect(appSource).not.toContain("onBuildPreview");
	expect(appSource).not.toContain("Preview Build</button>");
});

test("Changes exposes one Publish action that builds, plans, and applies", () => {
	expect(appSource).toContain("await buildProject(project.revision)");
	expect(appSource).toContain("const nextPlan = await planProject()");
	expect(appSource).toContain("applyProject(nextPlan.plan_token, nextPlan.destructive)");
	expect(appSource).toContain("onPublish={handlePublish}");
	expect(appSource).not.toContain("Plan Publish");
	expect(appSource).not.toContain("Publish reviewed Build");
	expect(appSource).not.toContain("onBuild(): void");
	expect(appSource).not.toContain(
		"Publish will build the working directory, generate a fresh plan, and update remote resources.",
	);
});

test("Changes compares the latest project version with the working directory", () => {
	expect(appSource).toContain("previewProjectVersion(headVersion, revision, headVersion)");
	expect(translationSource).toContain("Comparing the working directory with the latest published version");
	expect(appSource).toContain('direction="working-tree"');
	expect(translationSource).toContain("Source changes");
	expect(appSource).not.toContain("Generated YAML");
	expect(appSource).not.toContain("--- current Build");
	expect(appSource).not.toContain("+++ generated Build");
	expect(translationSource).toContain("Publish checks");
	expect(sourceFileDiffSource).toContain("showingWorkingChanges ? change.after : change.before");
	expect(sourceFileDiffSource).toContain("showingWorkingChanges ? change.before : change.after");
});

test("Changes separates the last declaration edit from pre-existing project actions", () => {
	expect(resourcesSource).toContain("const baselinePlan = await planProject().catch(() => undefined)");
	expect(appSource).toContain("comparePlanActions(baselinePlan.actions, plan.actions)");
	expect(appSource).toContain('title={t("app.changes.thisEdit")}');
	expect(appSource).toContain('title={t("app.changes.alreadyPending")}');
	expect(translationSource).toContain("Resolved by this edit");
	expect(translationSource).toContain("Publish executes both groups above");
});

test("resource declarations are always scoped to the selected Agent", () => {
	expect(resourcesSource).toContain('resource.type === "agent" && resource.id === selectedAgentId');
	expect(resourcesSource).toContain("resource.owner_agent === selectedAgentId");
	expect(resourcesSource).toContain(
		'resource.references.some((reference) => reference.type === "agent" && reference.id === selectedAgentId)',
	);
	expect(resourcesSource).not.toContain("dependencyOnly");
	expect(resourcesSource).not.toContain("Current Agent dependencies");
	expect(appSource).toContain('{tab === "overview" &&');
	expect(appSource).toContain("<ResourcesPanel");
	expect(appSource).toContain('action={t("app.agent.selectToEdit")}');
	expect(appSource).not.toContain("function Overview(");
	expect(appSource).not.toContain("function InfoCard(");
	expect(appSource).not.toContain('{ id: "resources", label: "Resources" }');
	expect(appSource).not.toContain('tab === "resources"');
});

test("deployment surface is not exposed in Workbench", () => {
	expect(appSource).not.toContain('{ id: "deployments", label: "Deployments" }');
	expect(appSource).not.toContain('tab === "deployments"');
	expect(appSource).not.toContain("function DeploymentsPanel(");
	expect(appSource).not.toContain("createApiDeployment");
	expect(appSource).not.toContain("runApiDeployment");
});

test("Agent readiness diagnostics explain invalid state in the main workspace", () => {
	expect(appSource).toContain("<ReadinessDiagnostics agent={selectedAgent} />");
	expect(appSource).toContain("agent.readiness.diagnostics");
	expect(translationSource).toContain("Why this Agent is {{status}}");
	expect(appSource).toContain("diagnostic.code");
	expect(appSource).toContain("diagnostic.message");
});

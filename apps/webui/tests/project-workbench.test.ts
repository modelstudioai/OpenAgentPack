import { expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const resourcesSource = await Bun.file(new URL("../src/resources/ResourcesPanel.tsx", import.meta.url)).text();
const versionsSource = await Bun.file(new URL("../src/versions/VersionsPanel.tsx", import.meta.url)).text();

test("project workbench is agents.yaml-driven with no Playbook or runtime model/provider override", () => {
	expect(appSource).toContain(
		'type WorkbenchTab = "overview" | "resources" | "changes" | "versions" | "debug" | "artifacts" | "deployments"',
	);
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

test("Versions is project-scoped, explicitly enabled, automatic after Apply, and supports redacted restore", () => {
	expect(appSource).toContain('{tab === "versions" && (');
	expect(appSource).toContain("This Apply will not create a local agents.yaml version");
	expect(appSource).not.toContain("initializeProjectVersioning");
	expect(appSource).toContain('addEventListener("project.mutation"');
	expect(versionsSource).toContain("Enable Local Versions");
	expect(versionsSource).toContain("Workbench and CLI share one local versioning switch");
	expect(versionsSource).toContain("Successful Apply creates a local snapshot.");
	expect(versionsSource).toContain("setProjectVersioning(projectRevision, !versioning.enabled)");
	expect(versionsSource).not.toContain("Create Version");
	expect(versionsSource).toContain("Restore to working tree");
	expect(versionsSource).toContain("buildYamlLineDiff(preview.before_yaml, preview.after_yaml)");
	expect(versionsSource).toContain("previewRequestGenerationRef");
	expect(versionsSource).toContain("preview.base_revision, preview.base_head_version");
	expect(versionsSource).toContain("Git is not required");
	expect(versionsSource).not.toContain("git push");
});

test("Apply mutation state blocks YAML/version writes while preserving resource drafts", () => {
	expect(appSource).toContain("writeBlockedReason={writeBlockedReason}");
	expect(resourcesSource).toContain("this draft is preserved, but saving is temporarily disabled");
	expect(resourcesSource).toContain("Boolean(writeBlockedReason)");
	expect(versionsSource).toContain("Boolean(writeBlockedReason)");
});

test("resource declarations require Preview before save and expose no create action", () => {
	expect(resourcesSource).toContain("previewDeclaration(");
	expect(resourcesSource).toContain("updateDeclaration(");
	expect(resourcesSource).toContain("deleteDeclaration(");
	expect(resourcesSource).toContain("Remove from agents.yaml");
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

test("Changes separates the last declaration edit from pre-existing project actions", () => {
	expect(resourcesSource).toContain("const baselinePlan = await planProject().catch(() => undefined)");
	expect(appSource).toContain("comparePlanActions(baselinePlan.actions, plan.actions)");
	expect(appSource).toContain('title="This edit"');
	expect(appSource).toContain('title="Already pending"');
	expect(appSource).toContain("Resolved by this edit");
	expect(appSource).toContain("Apply reviewed plan executes both groups above");
});

test("resource declarations are always scoped to the selected Agent", () => {
	expect(resourcesSource).toContain('resource.type === "agent" && resource.id === selectedAgentId');
	expect(resourcesSource).toContain(
		'resource.references.some((reference) => reference.type === "agent" && reference.id === selectedAgentId)',
	);
	expect(resourcesSource).not.toContain("dependencyOnly");
	expect(resourcesSource).not.toContain("Current Agent dependencies");
	expect(appSource).toContain('{tab === "resources" && selectedAgent && (');
	expect(appSource).toContain(
		'{tab === "resources" && !selectedAgent && <AgentRequiredPanel action="edit its resources" />}',
	);
});

test("deployment surface is explicitly read-only", () => {
	expect(appSource).toContain("Deployment declarations are read-only");
	expect(appSource).toContain("excluded from Workbench project Plan/Apply");
	expect(appSource).not.toContain("createApiDeployment");
	expect(appSource).not.toContain("runApiDeployment");
});

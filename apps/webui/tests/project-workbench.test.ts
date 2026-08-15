import { expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

test("project workbench is agents.yaml-driven with no Playbook or runtime model/provider override", () => {
	expect(appSource).toContain('type WorkbenchTab = "overview" | "changes" | "debug" | "artifacts" | "deployments"');
	expect(appSource).toContain("planAgent(");
	expect(appSource).toContain("applyAgent(");
	expect(appSource).toContain("projectEventSource(");
	expect(appSource).toContain('addEventListener("project.snapshot"');
	expect(appSource).toContain("projectRequestGenerationRef");
	expect(appSource).not.toContain("@/lib/playbooks");
	expect(appSource).not.toContain("SettingsDialog");
	expect(appSource).not.toContain("ModelSelector");
	expect(appSource).not.toContain("ProviderSelect");
});

test("deployment surface is explicitly read-only", () => {
	expect(appSource).toContain("Deployment declarations are read-only");
	expect(appSource).not.toContain("createApiDeployment");
	expect(appSource).not.toContain("runApiDeployment");
});

// Execute from an external consumer with only published/packed SDK dependencies.
// This verifies subpath packaging, shared error identity, and offline disk workflows.
export const projectSdkSmokeSource = `
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "@openagentpack/sdk";
import { ProjectVersionError } from "@openagentpack/sdk/project-versions";
import {
  DirectoryProjectMutationConflictError,
  initializeDirectoryProject,
  previewProjectBuild,
  commitProjectBuild,
  createDirectoryWorkspaceVersionService,
} from "@openagentpack/sdk/project-workspace";

assert.ok(new ProjectVersionError("version conflict") instanceof UserError);
assert.ok(new DirectoryProjectMutationConflictError("project conflict") instanceof UserError);
const root = await mkdtemp(join(tmpdir(), "agents-sdk-subpaths-"));
try {
  const initialized = await initializeDirectoryProject({ projectRoot: root });
  const service = createDirectoryWorkspaceVersionService(root);
  const instructionsPath = join(root, "agents/assistant/instructions.md");
  const original = await readFile(instructionsPath, "utf8");
  assert.equal((await service.listVersions()).versions[0].version_id, initialized.baseline_version);
  const preview = await previewProjectBuild(root);
  assert.equal(preview.can_build, true);
  const build = await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
  assert.ok(build.manifest.yaml_hash);
  await writeFile(instructionsPath, "Changed through the packed SDK.\\n");
  const restore = await service.previewVersion(initialized.baseline_version);
  assert.equal(restore.can_restore, true);
  assert.ok(restore.changes.some(change => change.path === "agents/assistant/instructions.md"));
  await service.restoreVersion(initialized.baseline_version, {
    projectRevision: restore.base_project_revision,
    headVersion: restore.base_head_version,
  });
  assert.equal(await readFile(instructionsPath, "utf8"), original);
} finally {
  await rm(root, { recursive: true, force: true });
}
`;

# npm releases

OpenAgentPack publishes `@openagentpack/sdk`, `@openagentpack/playground`, and `@openagentpack/cli` as one fixed version group. Real publishing happens only in GitHub Actions; local commands can build and dry-run the tarballs but cannot publish them.

## One-time repository setup

An organization owner must allow GitHub Actions to create pull requests in the organization Actions settings; then enable the matching option in **Repository Settings → Actions → General**. The Release PR workflow uses the repository `GITHUB_TOKEN`, not a personal token.

Create a GitHub Environment named `npm-release`. Add required reviewers so a maintainer must approve every npm publish job. Do not store an npm token in this environment. GitHub may expose reviewer protection only after the repository is public or on a qualifying private-repository plan.

On npmjs.com, open the settings for each of the three packages and configure the same Trusted Publisher:

| npm setting | Value |
|---|---|
| Provider | GitHub Actions |
| Organization | `modelstudioai` |
| Repository | `OpenAgentPack` |
| Workflow filename | `release.yml` |
| Environment | `npm-release` |

The workflow uses a GitHub-hosted runner, Node.js 24, npm 12, `id-token: write`, and provenance. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is required. The packages must already exist before npm lets you add a Trusted Publisher.

Only after the Trusted Publishers and Environment reviewers are ready, create the repository Actions variable `NPM_RELEASE_ENABLED` with value `true`. Its absence is a kill switch: publish jobs are skipped even if somebody manually dispatches the workflow.

## Changes required in every feature PR

Add a changeset whenever a user-visible package change is made:

```bash
bun run changeset
```

Choose the SemVer impact and describe the change for the generated changelog. Once merged, the **Release PR** workflow creates or updates a stable version PR on `main`. It never publishes npm packages.

## Publish a beta

1. In GitHub, open **Actions → Prepare Beta Release → Run workflow**.
2. Keep the workflow branch set to `main`, enter the target stable series (for example `0.1.0`), and run it.
3. The workflow creates or updates `release/0.1.0-beta`, consumes the available changesets, and commits the next version such as `0.1.0-beta.0`.
4. Open **Actions → Publish npm → Run workflow**.
5. Select `release/0.1.0-beta` in the workflow branch dropdown, choose `beta`, type `PUBLISH`, and run it.
6. Approve the `npm-release` Environment deployment after reviewing the commit and job summary.

The publish workflow validates that the selected branch, package version, and channel agree. It publishes with the npm `beta` dist-tag, creates an immutable `v0.1.0-beta.N` tag, and creates a GitHub prerelease.

For another beta, merge fixes and their changesets into `main`, then rerun **Prepare Beta Release** for the same series. The workflow merges `main` into the beta branch and calculates the next beta. Never merge the beta branch back into `main`; delete it after the stable release.

## Publish a stable release

1. Review and merge the automated `chore: release packages` PR.
2. Open **Actions → Publish npm → Run workflow**.
3. Select `main`, choose `stable`, type `PUBLISH`, and run it.
4. Approve the `npm-release` Environment deployment after reviewing the exact package version.

Only a clean `X.Y.Z` version on `main` can publish to npm's `latest` tag. A successful run creates the matching immutable Git tag and GitHub Release. Publishing is idempotent: packages whose exact version already exists are skipped, so a partially failed run can be retried.

## Local verification

```bash
bun run verify:release
```

This runs the full repository checks, builds the packages, performs `npm publish --dry-run`, and installs the packed artifacts into clean Node.js 20 and 24 consumer projects. To inspect only the package tarballs:

```bash
bun run build:packages
bun run release:publish -- --dry-run
```

The publish script blocks any real publish outside GitHub Actions.

## What users install

```bash
# Stable CLI (npm latest)
npm install --global @openagentpack/cli

# Beta CLI (npm beta)
npm install --global @openagentpack/cli@beta

# Pin or test an exact version without a global install
npx @openagentpack/cli@0.1.0-beta.0 --version

# SDK
npm install @openagentpack/sdk
```

After installing the CLI, run `agents --help`. A beta user returns to stable with `npm install --global @openagentpack/cli@latest`.

## Recovery

- If npm authentication fails, compare the Trusted Publisher repository, workflow filename, and Environment character-for-character with the table above.
- If a package published before another failed, rerun the same workflow from the same commit. Already-published exact versions are skipped.
- If a version tag already points at another commit, stop. Tags are immutable; investigate the repository history instead of moving or deleting the tag.
- If **Prepare Beta Release** reports no unreleased changesets, add a changeset on `main` before preparing another beta.

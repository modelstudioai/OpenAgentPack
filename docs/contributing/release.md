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

The publish workflow validates that the selected branch, package version, and channel agree. It publishes with the npm `beta` dist-tag and creates the immutable `v0.1.0-beta.N` tag. It then installs that exact version from the public npm registry on Linux, Windows, and macOS under Node.js 22 and 24. The GitHub prerelease is created only after all six consumer jobs pass.

For another beta, merge fixes and their changesets into `main`, then rerun **Prepare Beta Release** for the same series. The workflow merges `main` into the beta branch and calculates the next beta. Never merge the beta branch back into `main`; delete it after the stable release.

## Publish a stable release

1. Review and merge the automated `chore: release packages` PR.
2. Open **Actions → Publish npm → Run workflow**.
3. Select `main`, choose `stable`, type `PUBLISH`, and run it.
4. Approve the `npm-release` Environment deployment after reviewing the exact package version.

Only a clean `X.Y.Z` version on `main` can publish to npm's `latest` tag. Publishing creates the matching immutable Git tag, waits for all three packages to become visible in the public registry, and runs the six-job consumer matrix. The GitHub Release is the final certification step and is created only after that matrix passes. Publishing is idempotent: packages whose exact version already exists are skipped, so a partially failed publish can be retried from the same commit.

## Post-release consumer verification

The release is not considered complete when `npm publish` returns successfully. The workflow must also prove that a clean external consumer can install and execute the public packages from npm:

| Runner | Required Node.js versions |
|---|---|
| Ubuntu | 22, 24 |
| Windows | 22, 24 |
| macOS | 22, 24 |

Each matrix job installs the exact version independently, verifies npm registry signatures and provenance, loads every public SDK entry point, runs CLI help/version/offline validation, and starts the Playground over HTTP. It does not consume workspace packages, local tarballs, or build artifacts from the publish job.

The `Package compatibility canary` workflow also installs npm's `latest` release on all three operating systems under Node.js 26 every Wednesday. Canary failures do not affect an existing release, but they should be triaged before Node.js 26 becomes part of the supported LTS matrix.

## Local verification

```bash
bun run verify:release
```

This runs the full repository checks, builds the packages, performs a registry-independent `npm pack --dry-run`, and installs the packed artifacts as a clean external consumer. CI runs that package smoke under Node.js 22 and 24. To inspect only the package tarballs:

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
- If all packages published but a post-release consumer job fails, keep the immutable tag, do not unpublish or move the tag, and do not create the GitHub Release. Fix the compatibility issue and publish a new patch version; npm package versions cannot be overwritten.
- Registry visibility is retried for five minutes before it is classified as a release failure. Retry the same workflow only when npm propagation, rather than package compatibility, was the cause.
- If a version tag already points at another commit, stop. Tags are immutable; investigate the repository history instead of moving or deleting the tag.
- If **Prepare Beta Release** reports no unreleased changesets, add a changeset on `main` before preparing another beta.

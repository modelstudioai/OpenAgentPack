# Release

How `@openagentpack/sdk`, `@openagentpack/playground`, and `@openagentpack/cli` are published. This is a concise summary of the full procedure in [`packages/sdk/docs/release.md`](../../packages/sdk/docs/release.md).

## Principles

- npm packages publish **only** from GitHub Actions on `modelstudioai/OpenAgentPack`, via the `release.yml` workflow.
- Publishing uses **npm Trusted Publishing** (OIDC) — no long-lived write `NPM_TOKEN` is kept.
- Every release is gated by `bun run verify:release`, which runs the full check suite, package builds, `npm publish --dry-run`, and a packed-consumer smoke (importing every SDK entry point, running `agents --version`, and booting the Playground) on Node.js 20 and 24.
- Packages publish in topological order: `sdk → playground → cli`.

## First-time bootstrap

npm only allows configuring a Trusted Publisher for a package that already exists. Before the first release:

1. Create a short-lived granular npm token (allow creating public packages under `@openagentpack`) and save it as the GitHub Actions secret `NPM_TOKEN`.
2. The repository Actions variable `NPM_RELEASE_ENABLED` is intentionally absent while open-source review is pending. After approval, set it to `true` and manually dispatch the Release workflow to publish the verified prereleases with the `beta` dist-tag.
3. On each of the three npm packages, configure the Trusted Publisher: Provider `GitHub Actions`, org `modelstudioai`, repo `OpenAgentPack`, workflow `release.yml`, allowed action `npm publish`.
4. Delete the `NPM_TOKEN` secret, revoke the bootstrap token, require 2FA, and disallow traditional token publishing on all three packages.
5. Publish a subsequent beta through OIDC and verify the provenance link.

Requires npm CLI 11.5.1+ and Node.js 22.14+. The Release workflow uses Node.js 24, pins the npm CLI, and grants `id-token: write`.

## Day-to-day releases

Create a changeset in a feature PR:

```bash
bun run changeset
```

After merge to `main`, the Release workflow creates/updates a version PR, runs full verification, updates versions and changelogs, and publishes the three packages with OIDC and provenance. If a precise version already exists it is skipped, so a partially-failed release can be safely re-run.

## Beta / pre-release

```bash
bunx changeset pre enter beta
bun run changeset
# ... merge version PR ...
bunx changeset pre exit
```

Pre-release versions derive the npm dist-tag from the SemVer identifier (e.g. `1.0.1-beta.5` → `beta`), so `latest` is never occupied by a pre-release.

## Local verification

Local machines never perform a real publish — only verify what would be published:

```bash
bun run verify:release
# or check the packed packages directly:
bun run build:packages
bun run release:publish -- --dry-run --tag beta
```

The publish script temporarily rewrites `./src/*.ts` exports to `./dist/*.js`, resolves `workspace:` dependencies to real versions, and drops the root Apache-2.0 `LICENSE` into each tarball — restoring the workspace in `finally`.

## Troubleshooting

- `ENEEDAUTH` — for the first release, confirm the temporary `NPM_TOKEN` secret exists and allows creating a scoped public package. After bootstrap, confirm the Trusted Publisher org/repo/workflow match exactly and the workflow has `id-token: write`.
- Incomplete package contents — run `bun run verify:release` and confirm the dry-run output includes `README.md`, `LICENSE`, `package.json`, and built `dist/`.
- Leftover `package.json`/`LICENSE` changes — the publish script restores these on normal exit; if killed forcefully, check the workspace and remove only the temporary package-local `LICENSE`.

See [`packages/sdk/docs/release.md`](../../packages/sdk/docs/release.md) for the full procedure and troubleshooting.

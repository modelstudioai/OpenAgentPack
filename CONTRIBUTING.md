# Contributing to OpenAgentPack

Thanks for your interest in improving OpenAgentPack. By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Where to go

| Topic | Doc |
|-------|-----|
| Dev setup, verification, package boundaries | [docs/contributing/development.md](./docs/contributing/development.md) |
| Adding a new provider | [docs/contributing/provider-development.md](./docs/contributing/provider-development.md) |
| npm release workflow | [English](./docs/contributing/release.md) · [简体中文](./docs/contributing/release.zh-CN.md) |
| Architecture and how it works | [docs/architecture/how-it-works.md](./docs/architecture/how-it-works.md) |

## Quick start

```sh
git clone https://github.com/<your-github-user>/OpenAgentPack.git
cd OpenAgentPack
git remote add upstream https://github.com/modelstudioai/OpenAgentPack.git
bun install
bun run --cwd packages/cli bin/agents.ts --help   # run the CLI from source
bun run dev                                         # server + webui together
```

## Verification

```sh
bun run verify:scoped  # fast feedback loop
bun run verify:full    # repository gate (required for merge)
```

CI runs the `full` profile in parallel. See [Development](./docs/contributing/development.md) for every profile.

## Merge requirements

Every PR must satisfy:

1. `bun run verify:full`
2. At least one maintainer approval
3. No unresolved review comments

## Reporting bugs and requesting features

Open an issue using the templates under [.github/ISSUE_TEMPLATE](./.github/ISSUE_TEMPLATE). For anything security-related, do **not** open a public issue — follow [SECURITY.md](./SECURITY.md) instead.

For usage questions and design discussions, use [GitHub Discussions](https://github.com/modelstudioai/OpenAgentPack/discussions).

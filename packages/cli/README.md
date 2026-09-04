# `@openagentpack/cli`

The command-line interface for [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack), a declarative workflow for managing portable cloud AI-agent infrastructure.

## Install

```sh
npm install --global @openagentpack/cli
```

The package installs the `agents` command.

## Quick start

```sh
agents project init
agents project validate
agents project build --dry-run
agents project build --yes
agents project publish --yes
```

Directory projects store Agents and Skills as JSON, Markdown, and local files. `project build` previews full directory changes against the current version HEAD, organizes shared Skills, and writes `.openagentpack/build/agents.yaml`; `project publish` consumes only a current Build and records a full source-tree snapshot after complete remote success. Workbench and CLI use the same Git-independent switch under `agents project version ...`; snapshots include local Skill and binary content but exclude `.openagentpack/state.json`.

The legacy `agents init|validate|plan|apply` YAML workflow and `agents playground -f agents.yaml` Session Preview remain available. YAML Apply is independent from directory versions.

Use `agents <command> --help` for command-specific options.

## Documentation

- [Project README](https://github.com/modelstudioai/OpenAgentPack#readme)
- [Configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md)
- [Provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md)
- [Runnable examples](https://github.com/modelstudioai/OpenAgentPack/tree/main/examples)
- [Contributing](https://github.com/modelstudioai/OpenAgentPack/blob/main/CONTRIBUTING.md)

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

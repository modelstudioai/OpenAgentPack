# `@openagentpack/cli`

The command-line interface for [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack), a declarative workflow for managing portable cloud AI-agent infrastructure.

## Install

```sh
npm install --global @openagentpack/cli
```

The package installs the `agents` command.

## Quick start

```sh
agents init
agents validate
agents plan
agents apply
# Optional local agents.yaml history:
agents version enable --file agents.yaml
```

`agents version enable --file agents.yaml` creates or discovers a local Git repository, records the shared checkout-local switch for the selected `agents.yaml`, and creates a baseline commit when needed. Workbench reads the same switch, so enable/disable affects automatic commits in both hosts. Version commands use the explicit `--file <path>` option rather than a short `-f` alias. Subsequent successful Apply operations commit dirty YAML automatically. Use `agents version list`, `preview`, and `restore` to inspect or restore that history; versioning never commits `agents.state.json` or pushes to a remote.

Use `agents <command> --help` for command-specific options.

## Documentation

- [Project README](https://github.com/modelstudioai/OpenAgentPack#readme)
- [Configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md)
- [Provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md)
- [Runnable examples](https://github.com/modelstudioai/OpenAgentPack/tree/main/examples)
- [Contributing](https://github.com/modelstudioai/OpenAgentPack/blob/main/CONTRIBUTING.md)

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

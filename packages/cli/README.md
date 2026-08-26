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

`agents version enable --file agents.yaml` initializes `.openagentpack/versions`, records the shared local switch for the selected `agents.yaml`, and creates a baseline snapshot when needed. Workbench reads the same switch, so enable/disable affects automatic versions in both hosts. Version commands use the explicit `--file <path>` option rather than a short `-f` alias. Subsequent successful Apply operations snapshot dirty YAML automatically. Use `agents version list`, `preview`, and `restore` to inspect or restore that history; versioning never includes `agents.state.json` or referenced files.

Use `agents <command> --help` for command-specific options.

## Documentation

- [Project README](https://github.com/modelstudioai/OpenAgentPack#readme)
- [Configuration guide](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/configuration.md)
- [Provider reference](https://github.com/modelstudioai/OpenAgentPack/blob/main/docs/providers.md)
- [Runnable examples](https://github.com/modelstudioai/OpenAgentPack/tree/main/examples)
- [Contributing](https://github.com/modelstudioai/OpenAgentPack/blob/main/CONTRIBUTING.md)

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).

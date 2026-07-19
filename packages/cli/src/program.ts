import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { applyCommand } from "./commands/apply.ts";
import { deploymentGetCommand, deploymentListCommand, deploymentRunCommand } from "./commands/deployment.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { modelsListCommand } from "./commands/models.ts";
import { planCommand } from "./commands/plan.ts";
import { playgroundCommand } from "./commands/playground.ts";
import {
	sessionCreateCommand,
	sessionDeleteCommand,
	sessionEventsCommand,
	sessionGetCommand,
	sessionListCommand,
	sessionRunCommand,
	sessionSendCommand,
} from "./commands/session.ts";
import { stateImportCommand, stateListCommand, stateRemoveCommand, stateShowCommand } from "./commands/state.ts";
import { syncCommand } from "./commands/sync.ts";
import { validateCommand } from "./commands/validate.ts";
import { configureLogger } from "./logger.ts";
import {
	configFileOption,
	DEFAULT_CONFIG_FILE,
	parseBooleanOption,
	parsePositiveInteger,
	providerOption,
	withResolvedConfigFile,
} from "./runtime.ts";

function formatCliError(message: string, args = process.argv.slice(2)): string {
	const trimmed = message.trimEnd();

	if (trimmed.startsWith("error: unknown option")) {
		return `${trimmed}\n\nRun \`agents --help\` for available commands, or \`agents <command> --help\` for command options.\n`;
	}

	if (trimmed.includes("missing required argument")) {
		const cmd = args.filter((a) => !a.startsWith("-")).join(" ");
		const examples: Record<string, string> = {
			"session run": 'agents session run "your prompt here" -f agents.yaml',
			"session send": 'agents session send <session-id> "your message" -f agents.yaml',
			"session get": "agents session get <session-id> -f agents.yaml",
			"session delete": "agents session delete <session-id> -f agents.yaml",
		};
		const example = Object.entries(examples).find(([k]) => cmd.startsWith(k));
		if (example) {
			return `${trimmed}\n\nExample:\n  ${example[1]}\n`;
		}
		return `${trimmed}\n\nRun \`agents ${cmd} --help\` for usage details.\n`;
	}

	return `${message}`;
}

function readCliVersion(): string {
	const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		version?: string;
	};
	return manifest.version ?? "0.0.0-dev";
}

function countVerbose(_value: string, previous: number): number {
	return previous + 1;
}

export const program = new Command()
	.name("agents")
	.version(readCliVersion())
	.description("Open Agent Pack — Declaratively manage AI agent infrastructure")
	.option("-v, --verbose", "Increase logging verbosity (repeat: -vv)", countVerbose, 0)
	.option("-q, --quiet", "Suppress non-error output")
	.option("--no-color", "Disable colored output")
	.addOption(configFileOption().default(DEFAULT_CONFIG_FILE))
	.configureOutput({
		outputError: (message, write) => write(formatCliError(message)),
	})
	.hook("preAction", (cmd) => {
		const opts = cmd.opts();
		configureLogger({
			verbose: typeof opts.verbose === "number" ? opts.verbose : opts.verbose ? 1 : 0,
			quiet: !!opts.quiet,
			color: opts.color !== false,
		});
	});

program.command("init").description("Create a new agents.yaml template").action(initCommand);

program
	.command("playground")
	.description("Launch the local web UI (fetches @openagentpack/playground on demand) and open it in a browser")
	.option("--port <n>", "Port to serve on (default 4848)")
	.addOption(providerOption("Provider the UI targets"))
	.option("--no-open", "Do not open a browser automatically")
	.action(playgroundCommand);

program
	.command("validate")
	.description("Validate the configuration file (offline)")
	.addOption(configFileOption())
	.action(withResolvedConfigFile(validateCommand));

program
	.command("plan")
	.description("Show what changes would be applied")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider", { allowAll: true, defaultValue: "all" }))
	.option("--refresh <value>", "Refresh state from remote before planning (true/false)", parseBooleanOption, true)
	.option("--refresh-only", "Refresh state and show drift without planning remote mutations")
	.option("--json", "Output as JSON")
	.action(withResolvedConfigFile(planCommand));

program
	.command("apply")
	.description("Apply the planned changes to create/update/delete resources")
	.addOption(configFileOption())
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--refresh <value>", "Refresh state from remote before planning (true/false)", parseBooleanOption, true)
	.option("--refresh-only", "Refresh state without mutating remote resources")
	.option(
		"--concurrency <n>",
		"Max independent resources to apply in parallel (default 6, max 10)",
		parsePositiveInteger,
	)
	.addOption(providerOption("Target provider", { allowAll: true, defaultValue: "all" }))
	.action(withResolvedConfigFile(applyCommand));

program
	.command("destroy")
	.description("Destroy all managed resources")
	.addOption(configFileOption())
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--cascade", "Auto-delete dependent resources (e.g., sessions referencing an environment)")
	.action(withResolvedConfigFile(destroyCommand));

program
	.command("sync")
	.description("Export a provider's remote configuration into a local agents.yaml")
	.addOption(configFileOption())
	.addOption(providerOption("Source provider to sync from (defaults from config when -f is set)"))
	.option("-o, --out <path>", "Output file path", "agents.synced.yaml")
	.option("--force", "Overwrite the output file if it already exists")
	.option("--skip-missing-files", "Do not prompt for remote files that cannot be downloaded; omit them from output")
	.action(withResolvedConfigFile(syncCommand));

program
	.command("migrate")
	.description("Merge synced resources into the project agents.yaml (incremental, skip existing)")
	.option("--from <path>", "Source synced file", "agents.synced.yaml")
	.option("--to <path>", "Target agents.yaml file", "agents.yaml")
	.action(migrateCommand);

const stateCmd = program.command("state").description("Manage state file");

stateCmd
	.command("list")
	.description("List all resources in state")
	.addOption(configFileOption())
	.action(withResolvedConfigFile(stateListCommand));

stateCmd
	.command("show <address>")
	.description("Show details of a resource in state")
	.addOption(configFileOption())
	.action(withResolvedConfigFile(stateShowCommand));

stateCmd
	.command("rm <address>")
	.description("Remove a resource from state without destroying it remotely")
	.addOption(configFileOption())
	.action(withResolvedConfigFile(stateRemoveCommand));

stateCmd
	.command("import <address> <remote-id>")
	.description("Import an existing remote resource into state")
	.addOption(configFileOption())
	.addOption(
		new Option("--resource-version <number>", "Resource version (for versioned resources like agents)").argParser(
			parsePositiveInteger,
		),
	)
	.action(withResolvedConfigFile(stateImportCommand));

const sessionCmd = program.command("session").description("Manage agent sessions (runtime)");

sessionCmd
	.command("create [agent-name]")
	.description("Create a new session for an agent")
	.addOption(configFileOption())
	.option("--agent <name>", "Agent name (auto-detected when only one agent is configured)")
	.option("--environment <name>", "Override agent's declared environment")
	.option("--vault <name>", "Override agent's declared vault")
	.option("--memory-stores <names>", "Override agent's declared memory stores (comma-separated)")
	.option("--title <title>", "Session title")
	.addOption(providerOption("Target provider (required for multi-provider agents)"))
	.action(withResolvedConfigFile(sessionCreateCommand));

sessionCmd
	.command("list")
	.description("List sessions from the provider")
	.addOption(configFileOption())
	.option("--agent <name>", "Filter by agent name")
	.option("--all", "Fetch all pages by following the cursor")
	.addOption(providerOption("Target provider"))
	.action(withResolvedConfigFile(sessionListCommand));

sessionCmd
	.command("get <session-id>")
	.description("Get details of a session")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.action(withResolvedConfigFile(sessionGetCommand));

sessionCmd
	.command("delete <session-id>")
	.description("Delete a session")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.action(withResolvedConfigFile(sessionDeleteCommand));

sessionCmd
	.command("run <prompt-or-agent> [prompt]")
	.description("Create a session, send a message, and stream the response")
	.addOption(configFileOption())
	.option("--agent <name>", "Agent name (auto-detected when only one agent is configured)")
	.option("--environment <name>", "Override agent's declared environment")
	.option("--vault <name>", "Override agent's declared vault")
	.option("--memory-stores <names>", "Override agent's declared memory stores (comma-separated)")
	.option("--title <title>", "Session title")
	.addOption(providerOption("Target provider"))
	.option("--json", "Output events as JSONL")
	.option("--no-stream", "Use polling instead of SSE streaming")
	.action(withResolvedConfigFile(sessionRunCommand));

sessionCmd
	.command("send <session-id> <message>")
	.description("Send a message to an existing session and stream the response")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.option("--json", "Output events as JSONL")
	.option("--no-stream", "Use polling instead of SSE streaming")
	.action(withResolvedConfigFile(sessionSendCommand));

sessionCmd
	.command("events <session-id>")
	.description("List event history for a session")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.addOption(new Option("--limit <count>", "Maximum number of events to fetch").argParser(parsePositiveInteger))
	.option("--all", "Fetch all pages by following the cursor")
	.option("--json", "Output as JSON")
	.action(withResolvedConfigFile(sessionEventsCommand));

const deploymentCmd = program
	.command("deployment")
	.description("Manage agent deployments (scheduled / triggered runs)");

deploymentCmd
	.command("list")
	.description("List deployments tracked in state")
	.addOption(configFileOption())
	.addOption(providerOption("Filter by provider"))
	.action(withResolvedConfigFile(deploymentListCommand));

deploymentCmd
	.command("get <name>")
	.description("Show a deployment's status and resolved bindings")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.action(withResolvedConfigFile(deploymentGetCommand));

deploymentCmd
	.command("run <name>")
	.description("Trigger a deployment run (native on Claude, emulated as a session on Qoder)")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.action(withResolvedConfigFile(deploymentRunCommand));

const modelsCmd = program.command("models").description("Discover available models from providers");

modelsCmd
	.command("list")
	.description("List models available on the configured provider(s)")
	.addOption(configFileOption())
	.addOption(providerOption("Target provider"))
	.option("--json", "Output as JSON")
	.action(withResolvedConfigFile(modelsListCommand));

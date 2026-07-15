import { listProviderNames, UserError } from "@openagentpack/sdk";
import { Command, InvalidArgumentError, Option } from "commander";

export const DEFAULT_CONFIG_FILE = "agents.yaml";

type OptionValueSource = string | undefined;
type CommandHandler = (...args: never[]) => unknown | Promise<unknown>;

function isExplicitSource(source: OptionValueSource): boolean {
	return source !== undefined && source !== "default";
}

function rootCommand(command: Command): Command {
	let current = command;
	while (current.parent) current = current.parent;
	return current;
}

function configFileArgs(args = process.argv.slice(2)): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (arg === "-f" || arg === "--file") {
			const value = args[i + 1];
			if (value) {
				values.push(value);
				i += 1;
				continue;
			}
		}
		if (arg.startsWith("--file=")) {
			values.push(arg.slice("--file=".length));
			continue;
		}
		if (arg.startsWith("-f") && arg.length > 2) {
			values.push(arg.slice(2));
		}
	}
	return values;
}

export function configFileOption(): Option {
	return new Option("-f, --file <path>", "Config file path");
}

export function resolveConfigFile(command: Command): string {
	const explicitFiles = [...new Set(configFileArgs())];
	if (explicitFiles.length > 1) {
		throw new UserError(
			`Conflicting config files supplied: ${explicitFiles.join(" and ")}. Use only one --file value.`,
		);
	}

	const root = rootCommand(command);
	const rootFile = root.getOptionValue("file") as string | undefined;
	const rootSource = root.getOptionValueSource("file");
	const localFile = command.getOptionValue("file") as string | undefined;
	const localSource = command.getOptionValueSource("file");

	if (
		isExplicitSource(rootSource) &&
		isExplicitSource(localSource) &&
		rootFile &&
		localFile &&
		rootFile !== localFile
	) {
		throw new UserError(`Conflicting config files supplied: ${rootFile} and ${localFile}. Use only one --file value.`);
	}

	if (isExplicitSource(localSource) && localFile) return localFile;
	if (rootFile) return rootFile;
	return DEFAULT_CONFIG_FILE;
}

export function withResolvedConfigFile(handler: CommandHandler): (...args: unknown[]) => Promise<void> {
	return async (...args: unknown[]) => {
		const command = args[args.length - 1];
		if (!(command instanceof Command)) {
			await handler(...(args as never[]));
			return;
		}

		const handlerArgs = args.slice(0, -1);
		const options = handlerArgs[handlerArgs.length - 1];
		if (options && typeof options === "object") {
			(options as { file?: string }).file = resolveConfigFile(command);
		}

		await handler(...(handlerArgs as never[]));
	};
}

function registeredProviderNames(): string[] {
	return listProviderNames();
}

export function providerOption(description: string, opts: { allowAll?: boolean; defaultValue?: string } = {}): Option {
	const choices = opts.allowAll ? ["all", ...registeredProviderNames()] : registeredProviderNames();
	const option = new Option("--provider <name>", description).choices(choices);
	if (opts.defaultValue !== undefined) option.default(opts.defaultValue);
	return option;
}

export function parsePositiveInteger(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	return parsed;
}

export function parseBooleanOption(value: string): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new InvalidArgumentError("must be true or false");
}

export function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

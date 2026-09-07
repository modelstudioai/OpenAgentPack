import { readFile, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { UserError } from "@openagentpack/sdk";
import { log } from "../logger.ts";
import { fileExists } from "../utils/file-utils.ts";

const PROVIDERS = ["bailian", "claude", "qoder", "ark", "all"] as const;
type InitProvider = (typeof PROVIDERS)[number];

const LOCAL_GITIGNORE_PATTERNS = ["agents.state.json", ".openagentpack/versions/", ".env"] as const;

export interface InitCommandOptions {
	provider?: string;
	agentName?: string;
}

function buildTemplate(options: { provider: InitProvider; agentName: string }): string {
	const agentKey = yamlMappingKey(options.agentName);
	const providers: Record<Exclude<InitProvider, "all">, string> = {
		bailian: `  bailian:\n    api_key: \${DASHSCOPE_API_KEY}\n    workspace_id: \${BAILIAN_WORKSPACE_ID}`,
		claude: `  claude:\n    api_key: \${ANTHROPIC_API_KEY}`,
		qoder: `  qoder:\n    api_key: \${QODER_PAT}\n    gateway: "https://api.qoder.com/api/v1/cloud"`,
		ark: `  ark:\n    api_key: \${ARK_API_KEY}`,
	};
	const providerBlock =
		options.provider === "all"
			? `${providers.bailian}\n${providers.claude}\n${providers.qoder}\n${providers.ark}`
			: providers[options.provider];
	const singleModel: Record<Exclude<InitProvider, "all">, string> = {
		bailian: "    model: qwen3.7-max",
		claude: "    model: claude-sonnet-4-6",
		qoder: "    model: ultimate",
		ark: "    model: doubao-seed-2-1-pro-260628",
	};
	const modelBlock =
		options.provider === "all"
			? `    model:\n      bailian: qwen3.7-max\n      claude: claude-sonnet-4-6\n      qoder: ultimate\n      ark: doubao-seed-2-1-pro-260628`
			: singleModel[options.provider];
	const toolBlock =
		options.provider === "bailian" ? "[bash, read, glob, grep]" : "[read, glob, grep, web_search, web_fetch]";

	return `version: "1"

providers:
${providerBlock}

defaults:
  provider: ${options.provider === "all" ? "all" : options.provider}

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  ${agentKey}:
    description: "General-purpose assistant"
${modelBlock}
    instructions: |
      You are a helpful assistant.
    environment: dev
    tools:
      builtin: ${toolBlock}
`;
}

function yamlMappingKey(value: string): string {
	return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(value) ? value : JSON.stringify(value);
}

function parseProvider(provider: string): InitProvider {
	if (PROVIDERS.includes(provider as InitProvider)) return provider as InitProvider;
	throw new UserError(`Unsupported provider '${provider}'. Choose one of: ${PROVIDERS.join(", ")}.`);
}

async function promptForProjectOptions(
	options: InitCommandOptions,
): Promise<{ provider: InitProvider; agentName: string }> {
	const provider = options.provider
		? parseProvider(options.provider)
		: ((await p.select({
				message: "Which provider(s) do you want to use?",
				options: [
					{ value: "bailian", label: "Bailian (阿里云百炼)" },
					{ value: "claude", label: "Claude" },
					{ value: "qoder", label: "Qoder" },
					{ value: "ark", label: "Ark（火山方舟）" },
					{ value: "all", label: "All providers" },
				],
				output: process.stderr,
			})) as string | symbol);
	if (p.isCancel(provider)) {
		p.cancel("Init cancelled.", { output: process.stderr });
		process.exit(0);
	}

	const agentName = options.agentName
		? options.agentName
		: await p.text({
				message: "Name your first agent:",
				placeholder: "assistant",
				defaultValue: "assistant",
				output: process.stderr,
			});
	if (p.isCancel(agentName)) {
		p.cancel("Init cancelled.", { output: process.stderr });
		process.exit(0);
	}
	const normalizedAgentName = agentName.trim();
	if (!normalizedAgentName) throw new UserError("Agent name cannot be empty.");
	return { provider: parseProvider(provider), agentName: normalizedAgentName };
}

export async function initCommand(options: InitCommandOptions): Promise<void> {
	const configPath = "agents.yaml";
	if (await fileExists(configPath)) {
		log.warn(`${configPath} already exists, skipping.`);
		return;
	}

	p.intro("agents init", { output: process.stderr });
	const answers = await promptForProjectOptions(options);
	await writeFile(configPath, buildTemplate(answers), "utf8");
	p.log.success(`Created ${configPath}`, { output: process.stderr });

	const gitignorePath = ".gitignore";
	const currentGitignore = (await fileExists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
	const existingPatterns = new Set(currentGitignore.split(/\r?\n/).map((line) => line.trim()));
	const missingPatterns = LOCAL_GITIGNORE_PATTERNS.filter((pattern) => !existingPatterns.has(pattern));
	if (missingPatterns.length > 0) {
		const separator = currentGitignore.length === 0 || currentGitignore.endsWith("\n") ? "" : "\n";
		const heading = currentGitignore.length === 0 ? "# agents\n" : "\n# agents\n";
		await writeFile(gitignorePath, `${currentGitignore}${separator}${heading}${missingPatterns.join("\n")}\n`, "utf8");
		p.log.success(`${currentGitignore.length === 0 ? "Created" : "Updated"} .gitignore`, {
			output: process.stderr,
		});
	}

	p.outro("Done! Next: edit agents.yaml, then run agents plan", { output: process.stderr });
}

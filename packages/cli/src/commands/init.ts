import { readFile, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { log } from "../logger.ts";
import { fileExists } from "../utils/file-utils.ts";

const GITIGNORE_ADDITIONS = `
# agents
agents.state.json
.env
`;

function buildTemplate(opts: { provider: string; agentName: string }) {
	const providers: Record<string, string> = {
		bailian: `  bailian:\n    api_key: \${DASHSCOPE_API_KEY}\n    workspace_id: \${BAILIAN_WORKSPACE_ID}`,
		claude: `  claude:\n    api_key: \${ANTHROPIC_API_KEY}`,
		qoder: `  qoder:\n    api_key: \${QODER_PAT}\n    gateway: "https://api.qoder.com/api/v1/cloud"`,
		ark: `  ark:\n    api_key: \${ARK_API_KEY}`,
	};

	let providerBlock: string;
	if (opts.provider === "all") {
		providerBlock = `${providers.bailian}\n${providers.claude}\n${providers.qoder}\n${providers.ark}`;
	} else {
		providerBlock = providers[opts.provider]!;
	}

	const singleModel: Record<string, string> = {
		bailian: `    model: qwen3.7-max`,
		claude: `    model: claude-sonnet-4-6`,
		qoder: `    model: ultimate`,
		ark: `    model: doubao-seed-2-1-pro-260628`,
	};

	const modelBlock =
		opts.provider === "all"
			? `    model:\n      bailian: qwen3.7-max\n      claude: claude-sonnet-4-6\n      qoder: ultimate\n      ark: doubao-seed-2-1-pro-260628`
			: singleModel[opts.provider]!;
	const toolBlock =
		opts.provider === "bailian" ? "[bash, read, glob, grep]" : "[read, glob, grep, web_search, web_fetch]";

	return `version: "1"

providers:
${providerBlock}

defaults:
  provider: ${opts.provider === "all" ? "all" : opts.provider}

environments:
  dev:
    config:
      type: cloud
      networking:
        type: unrestricted

agents:
  ${opts.agentName}:
    description: "General-purpose assistant"
${modelBlock}
    instructions: |
      You are a helpful assistant.
    environment: dev
    tools:
      builtin: ${toolBlock}
`;
}

export async function initCommand() {
	const configPath = "agents.yaml";

	if (await fileExists(configPath)) {
		log.warn(`${configPath} already exists, skipping.`);
		return;
	}

	p.intro("agents init", { output: process.stderr });

	const answers = await p.group(
		{
			provider: () =>
				p.select({
					message: "Which provider(s) do you want to use?",
					options: [
						{ value: "bailian", label: "Bailian (阿里云百炼)" },
						{ value: "claude", label: "Claude" },
						{ value: "qoder", label: "Qoder" },
						{ value: "ark", label: "Ark（火山方舟）" },
						{ value: "all", label: "All providers" },
					],
					output: process.stderr,
				}),
			agentName: () =>
				p.text({
					message: "Name your first agent:",
					placeholder: "assistant",
					defaultValue: "assistant",
					output: process.stderr,
				}),
		},
		{
			onCancel: () => {
				p.cancel("Init cancelled.", { output: process.stderr });
				process.exit(0);
			},
		},
	);

	const template = buildTemplate({
		provider: answers.provider as string,
		agentName: answers.agentName as string,
	});

	await writeFile(configPath, template, "utf8");
	p.log.success(`Created ${configPath}`, { output: process.stderr });

	const gitignorePath = ".gitignore";
	if (await fileExists(gitignorePath)) {
		const content = await readFile(gitignorePath, "utf8");
		if (!content.includes("agents.state.json")) {
			await writeFile(gitignorePath, content + GITIGNORE_ADDITIONS, "utf8");
			p.log.success("Updated .gitignore", { output: process.stderr });
		}
	} else {
		await writeFile(gitignorePath, `${GITIGNORE_ADDITIONS.trim()}\n`, "utf8");
		p.log.success("Created .gitignore", { output: process.stderr });
	}

	p.outro("Done! Next: edit agents.yaml, then run agents plan", {
		output: process.stderr,
	});
}

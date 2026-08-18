import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { UserError } from "@openagentpack/sdk";
import { log } from "../logger.ts";
import { fileExists } from "../utils/file-utils.ts";

const execFileAsync = promisify(execFile);
const PROVIDERS = ["bailian", "claude", "qoder", "ark", "all"] as const;
type InitProvider = (typeof PROVIDERS)[number];

const GITIGNORE_ADDITIONS = `
# agents
agents.state.json
.env
`;

const REPOSITORY_GITIGNORE = `# Dependencies
node_modules/

# OpenAgentPack local runs
.openagentpack/state/
.openagentpack/runs/

# Local credentials
.env
.env.*
!.env.example
`;

const REPOSITORY_GITIGNORE_PATTERNS = [
	"node_modules/",
	".openagentpack/state/",
	".openagentpack/runs/",
	".env",
	".env.*",
	"!.env.example",
] as const;

const PROJECT_SCRIPTS = {
	"agents:validate": "agents validate -f agents.yaml",
	"agents:plan": "agents plan -f agents.yaml",
	"agents:plan:ci": "agents plan -f agents.yaml --json",
	"agents:apply:ci": "agents apply -f agents.yaml --ci",
	"agents:workbench": "agents workbench -f agents.yaml",
} as const;

const LEGACY_PROJECT_SCRIPTS: Record<string, readonly string[]> = {
	"agents:plan:ci": ["agents plan -f agents.yaml --refresh false --json"],
	"agents:apply:ci": ["agents apply -f agents.yaml --yes"],
};

const INITIAL_STATE = `${JSON.stringify({ resources: [] }, null, 2)}\n`;

export interface InitCommandOptions {
	provider?: string;
	agentName?: string;
	git?: string;
}

export interface GitProjectOptions {
	provider?: InitProvider;
	agentName?: string;
	cliVersion: string;
	initializeGit?: boolean;
}

export interface GitProjectResult {
	targetDirectory: string;
	mode: "created" | "upgraded";
	initializedGit: boolean;
	createdFiles: string[];
	updatedFiles: string[];
	preservedFiles: string[];
}

type ProjectTargetMode = "new" | "existing";

function buildTemplate(opts: {
	provider: InitProvider;
	agentName: string;
	instructionsPath?: string;
	repositoryMode?: boolean;
}) {
	const agentKey = yamlMappingKey(opts.agentName);
	const providers: Record<Exclude<InitProvider, "all">, string> = {
		bailian: opts.repositoryMode
			? `  bailian:\n    api_key: \${DASHSCOPE_API_KEY}\n    base_url: \${BAILIAN_BASE_URL}`
			: `  bailian:\n    api_key: \${DASHSCOPE_API_KEY}\n    workspace_id: \${BAILIAN_WORKSPACE_ID}`,
		claude: `  claude:\n    api_key: \${ANTHROPIC_API_KEY}`,
		qoder: `  qoder:\n    api_key: \${QODER_PAT}\n    gateway: "https://api.qoder.com/api/v1/cloud"`,
		ark: `  ark:\n    api_key: \${ARK_API_KEY}`,
	};

	let providerBlock: string;
	if (opts.provider === "all") {
		providerBlock = `${providers.bailian}\n${providers.claude}\n${providers.qoder}\n${providers.ark}`;
	} else {
		providerBlock = providers[opts.provider];
	}

	const singleModel: Record<Exclude<InitProvider, "all">, string> = {
		bailian: `    model: qwen3.7-max`,
		claude: `    model: claude-sonnet-4-6`,
		qoder: `    model: ultimate`,
		ark: `    model: doubao-seed-2-1-pro-260628`,
	};

	const modelBlock =
		opts.provider === "all"
			? `    model:\n      bailian: qwen3.7-max\n      claude: claude-sonnet-4-6\n      qoder: ultimate\n      ark: doubao-seed-2-1-pro-260628`
			: singleModel[opts.provider];
	const toolBlock =
		opts.provider === "bailian" ? "[bash, read, glob, grep]" : "[read, glob, grep, web_search, web_fetch]";
	const instructionsBlock = opts.instructionsPath
		? `    instructions: ${opts.instructionsPath}`
		: `    instructions: |\n      You are a helpful assistant.`;

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
  ${agentKey}:
    description: "General-purpose assistant"
${modelBlock}
${instructionsBlock}
    environment: dev
    tools:
      builtin: ${toolBlock}
`;
}

function yamlMappingKey(value: string): string {
	return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(value) ? value : JSON.stringify(value);
}

function environmentExample(provider: InitProvider, repositoryMode = false): string {
	const variables: Record<Exclude<InitProvider, "all">, string[]> = {
		bailian: repositoryMode
			? ["DASHSCOPE_API_KEY=replace-me", "BAILIAN_BASE_URL=replace-me"]
			: ["DASHSCOPE_API_KEY=replace-me", "BAILIAN_WORKSPACE_ID=replace-me"],
		claude: ["ANTHROPIC_API_KEY=replace-me"],
		qoder: ["QODER_PAT=replace-me"],
		ark: ["ARK_API_KEY=replace-me"],
	};
	const selected = provider === "all" ? PROVIDERS.filter((entry) => entry !== "all") : [provider];
	return `${selected.flatMap((entry) => variables[entry]).join("\n")}\n`;
}

function buildPackageJson(projectName: string, cliVersion: string): string {
	return `${JSON.stringify(
		{
			name: npmPackageName(projectName),
			private: true,
			version: "0.0.0",
			type: "module",
			scripts: PROJECT_SCRIPTS,
			devDependencies: {
				"@openagentpack/cli": cliVersion,
			},
		},
		null,
		2,
	)}\n`;
}

function buildAoneEnvironmentBlock(config: string): string {
	const variables = extractEnvironmentVariables(config);
	if (variables.length === 0) {
		return "          # Add provider variables in Aone Flow when agents.yaml uses environment placeholders.";
	}
	return variables.map((variable) => `          ${variable}: \${{secrets.${variable}}}`).join("\n");
}

function buildAoneWorkflow(config: string): string {
	const environmentBlock = buildAoneEnvironmentBlock(config);
	return `name: OpenAgentPack

triggers:
  push:
    branches:
      - main

jobs:
  apply:
    name: Validate, plan, and apply Agent resources
    image: alios-8u
    timeout: 30m
    steps:
      - id: checkout
        uses: checkout

      - id: setup-env
        uses: setup-env
        inputs:
          node-version: 22
          tnpm-version: 10
          tnpm-cache: true

      - id: install
        run: npm install --ignore-scripts --no-audit --no-fund

      - id: validate-and-plan
        envs:
${environmentBlock}
        run: |
          npm run agents:validate
          npm run agents:plan:ci > openagentpack-plan.json

      - id: upload-plan
        uses: upload-artifact
        inputs:
          name: openagentpack-plan
          path: openagentpack-plan.json

      # Configure this pipeline with concurrency 1 and grant the checkout identity
      # write access to main. Approval and merge-request checks are configured in Aone.
      - id: apply-and-persist-state
        envs:
${environmentBlock}
        run: |
          set +e
          npm run agents:apply:ci
          apply_status=$?
          set -e

          if ! git diff --quiet -- agents.state.json; then
            git config user.name "OpenAgentPack CI"
            git config user.email "openagentpack-ci@alibaba-inc.com"
            git add -- agents.state.json
            git commit -m "chore: update OpenAgentPack state [skip ci]"
            git push origin HEAD:main
          fi

          exit "$apply_status"
`;
}

function buildAoneCheckWorkflow(config: string): string {
	const environmentBlock = buildAoneEnvironmentBlock(config);
	return `name: OpenAgentPack Check

# Bind this pipeline to Codeup merge-request new/update events in Aone Flow.
jobs:
  check:
    name: Validate and plan Agent resources
    image: alios-8u
    timeout: 20m
    steps:
      - id: checkout
        uses: checkout

      - id: setup-env
        uses: setup-env
        inputs:
          node-version: 22
          tnpm-version: 10
          tnpm-cache: true

      - id: install
        run: npm install --ignore-scripts --no-audit --no-fund

      - id: validate-and-plan
        envs:
${environmentBlock}
        run: |
          npm run agents:validate
          npm run agents:plan:ci > openagentpack-plan.json

      - id: upload-plan
        uses: upload-artifact
        inputs:
          name: openagentpack-plan
          path: openagentpack-plan.json
`;
}

function buildReadme(projectName: string, config: string): string {
	const environmentVariables = extractEnvironmentVariables(config);
	const variableList =
		environmentVariables.length > 0
			? environmentVariables.map((variable) => `- \`${variable}\``).join("\n")
			: "- Add the provider variables referenced by `agents.yaml`.";
	return `# ${projectName}

This repository declares cloud Agent resources with OpenAgentPack.

## Local preview

1. Copy \`.env.example\` to \`.env\` and replace the placeholder credentials.
2. Run \`npm install\`.
3. Run \`npm run agents:workbench\` to plan, apply, and debug the Agent in a preview workspace.

## Aone CI deployment

\`.aoneci/openagentpack-check.yml\` validates and plans merge requests without applying. Bind it to Codeup merge-request new/update events in Aone Flow. \`.aoneci/openagentpack.yml\` applies non-destructive local changes after a push to \`main\` and commits the resulting \`agents.state.json\` back to \`main\`. Its CI policy blocks deletes and remote drift; handle those through a separate explicitly approved workflow.

Configure these values as secret variables in Aone Flow. Local Workbench values come from \`.env\`, so the same variable names can point at an isolated local-debug endpoint and a separate CI endpoint:

${variableList}

In Aone, set pipeline concurrency to 1, require approval before the apply step when needed, and grant the checkout identity permission to push \`agents.state.json\` to \`main\`. Configure merge-request validation and branch protection in Aone/Codeup. The state file is CI-owned and may contain remote resource metadata, so keep this repository private and do not edit the file manually.

Create the remote repository yourself, then push this local repository:

\`\`\`bash
git add .
git commit -m "Initialize OpenAgentPack project"
git remote add origin <your-codeup-repository-url>
git push -u origin main
\`\`\`
`;
}

function npmPackageName(projectName: string): string {
	const normalized = projectName
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "");
	return normalized || "openagentpack-project";
}

function instructionFilename(agentName: string): string {
	return `${npmPackageName(agentName)}.md`;
}

function parseProvider(provider: string): InitProvider {
	if (PROVIDERS.includes(provider as InitProvider)) return provider as InitProvider;
	throw new UserError(`Unsupported provider '${provider}'. Choose one of: ${PROVIDERS.join(", ")}.`);
}

async function inspectProjectTarget(targetDirectory: string): Promise<ProjectTargetMode> {
	if (!existsSync(targetDirectory)) return "new";
	const targetStat = await stat(targetDirectory);
	if (!targetStat.isDirectory()) {
		throw new UserError(`Target '${targetDirectory}' is not a directory.`);
	}
	const entries = await readdir(targetDirectory);
	if (entries.length === 0) return "new";
	if (await fileExists(resolve(targetDirectory, "agents.yaml"))) return "existing";
	throw new UserError(`Target directory '${targetDirectory}' is not empty and does not contain agents.yaml.`);
}

async function initializeGitRepository(targetDirectory: string): Promise<void> {
	try {
		await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: targetDirectory });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new UserError(`Could not initialize the local Git repository: ${message}`);
	}
}

function appendBlock(content: string, block: string): string {
	if (!content) return block;
	if (content.endsWith("\n\n")) return `${content}${block}`;
	if (content.endsWith("\n")) return `${content}\n${block}`;
	return `${content}\n\n${block}`;
}

function mergeGitignore(content: string): string {
	const repositoryContent = content
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "agents.state.json")
		.join("\n");
	const existingPatterns = new Set(
		repositoryContent
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean),
	);
	const missingPatterns = REPOSITORY_GITIGNORE_PATTERNS.filter((pattern) => !existingPatterns.has(pattern));
	if (missingPatterns.length === 0) return repositoryContent;
	return appendBlock(repositoryContent, `# OpenAgentPack local files\n${missingPatterns.join("\n")}\n`);
}

function extractEnvironmentVariables(config: string): string[] {
	const variables = new Set<string>();
	for (const match of config.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
		if (match[1]) variables.add(match[1]);
	}
	return [...variables];
}

function mergeEnvironmentExample(content: string, config: string): string {
	const existingVariables = new Set<string>();
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match?.[1]) existingVariables.add(match[1]);
	}
	const missingVariables = extractEnvironmentVariables(config).filter((variable) => !existingVariables.has(variable));
	if (missingVariables.length === 0) return content;
	const additions = `${missingVariables.map((variable) => `${variable}=replace-me`).join("\n")}\n`;
	return content ? appendBlock(content, additions) : additions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePackageJson(
	content: string,
	projectName: string,
	cliVersion: string,
): { content: string; preservedSettings: string[] } {
	let manifest: unknown;
	try {
		manifest = JSON.parse(content);
	} catch {
		throw new UserError("Cannot upgrade package.json because it is not valid JSON.");
	}
	if (!isRecord(manifest)) throw new UserError("Cannot upgrade package.json because its root is not an object.");

	const preservedSettings: string[] = [];
	let changed = false;
	if (manifest.name === undefined) {
		manifest.name = npmPackageName(projectName);
		changed = true;
	}
	if (manifest.private === undefined) {
		manifest.private = true;
		changed = true;
	}

	const scripts = manifest.scripts === undefined ? {} : manifest.scripts;
	if (!isRecord(scripts)) throw new UserError("Cannot upgrade package.json because 'scripts' is not an object.");
	if (manifest.scripts === undefined) {
		manifest.scripts = scripts;
		changed = true;
	}
	let usesManagedScripts = false;
	for (const [name, command] of Object.entries(PROJECT_SCRIPTS)) {
		if (scripts[name] === undefined) {
			scripts[name] = command;
			changed = true;
			usesManagedScripts = true;
		} else if (LEGACY_PROJECT_SCRIPTS[name]?.includes(String(scripts[name]))) {
			scripts[name] = command;
			changed = true;
			usesManagedScripts = true;
		} else if (scripts[name] === command) {
			usesManagedScripts = true;
		} else if (scripts[name] !== command) {
			preservedSettings.push(`package.json scripts.${name}`);
		}
	}

	const dependencies = manifest.dependencies;
	if (dependencies !== undefined && !isRecord(dependencies)) {
		throw new UserError("Cannot upgrade package.json because 'dependencies' is not an object.");
	}
	const devDependencies = manifest.devDependencies === undefined ? {} : manifest.devDependencies;
	if (!isRecord(devDependencies)) {
		throw new UserError("Cannot upgrade package.json because 'devDependencies' is not an object.");
	}
	if (manifest.devDependencies === undefined) {
		manifest.devDependencies = devDependencies;
		changed = true;
	}
	const dependencyCliVersion = dependencies?.["@openagentpack/cli"];
	const devDependencyCliVersion = devDependencies["@openagentpack/cli"];
	if (dependencyCliVersion === undefined && devDependencyCliVersion === undefined) {
		devDependencies["@openagentpack/cli"] = cliVersion;
		changed = true;
	} else if (usesManagedScripts) {
		if (dependencyCliVersion !== undefined && dependencyCliVersion !== cliVersion) {
			dependencies!["@openagentpack/cli"] = cliVersion;
			changed = true;
		}
		if (devDependencyCliVersion !== undefined && devDependencyCliVersion !== cliVersion) {
			devDependencies["@openagentpack/cli"] = cliVersion;
			changed = true;
		}
	} else if (dependencyCliVersion !== cliVersion && devDependencyCliVersion !== cliVersion) {
		preservedSettings.push("package.json @openagentpack/cli version");
	}

	return {
		content: changed ? `${JSON.stringify(manifest, null, 2)}\n` : content,
		preservedSettings,
	};
}

export async function createGitProject(directory: string, options: GitProjectOptions): Promise<GitProjectResult> {
	const targetDirectory = resolve(directory);
	const targetMode = await inspectProjectTarget(targetDirectory);
	const gitMetadataPath = resolve(targetDirectory, ".git");
	const shouldInitializeGit = options.initializeGit !== false && !existsSync(gitMetadataPath);
	if (shouldInitializeGit) {
		try {
			await execFileAsync("git", ["--version"]);
		} catch {
			throw new UserError("Git is required to initialize a repository. Install Git and retry.");
		}
	}

	const projectName = basename(targetDirectory);
	const createdFiles: string[] = [];
	const updatedFiles: string[] = [];
	const preservedFiles: string[] = [];

	if (targetMode === "new") {
		if (!options.provider || !options.agentName) {
			throw new UserError("Provider and Agent name are required when creating a new Git repository project.");
		}
		const instructionFile = instructionFilename(options.agentName);
		await mkdir(resolve(targetDirectory, "instructions"), { recursive: true });
		await mkdir(resolve(targetDirectory, ".aoneci"), { recursive: true });
		const config = buildTemplate({
			provider: options.provider,
			agentName: options.agentName,
			instructionsPath: `./instructions/${instructionFile}`,
			repositoryMode: true,
		});
		await writeFile(resolve(targetDirectory, "agents.yaml"), config, "utf8");
		await writeFile(
			resolve(targetDirectory, "instructions", instructionFile),
			"You are a helpful assistant.\n",
			"utf8",
		);
		await writeFile(resolve(targetDirectory, ".env.example"), environmentExample(options.provider, true), "utf8");
		await writeFile(resolve(targetDirectory, ".gitignore"), REPOSITORY_GITIGNORE, "utf8");
		await writeFile(
			resolve(targetDirectory, "package.json"),
			buildPackageJson(projectName, options.cliVersion),
			"utf8",
		);
		await writeFile(resolve(targetDirectory, "agents.state.json"), INITIAL_STATE, "utf8");
		await writeFile(resolve(targetDirectory, "README.md"), buildReadme(projectName, config), "utf8");
		await writeFile(resolve(targetDirectory, ".aoneci/openagentpack.yml"), buildAoneWorkflow(config), "utf8");
		await writeFile(
			resolve(targetDirectory, ".aoneci/openagentpack-check.yml"),
			buildAoneCheckWorkflow(config),
			"utf8",
		);
		createdFiles.push(
			"agents.yaml",
			"agents.state.json",
			`instructions/${instructionFile}`,
			".env.example",
			".gitignore",
			"package.json",
			"README.md",
			".aoneci/openagentpack.yml",
			".aoneci/openagentpack-check.yml",
		);
	} else {
		const config = await readFile(resolve(targetDirectory, "agents.yaml"), "utf8");
		const packageJsonPath = resolve(targetDirectory, "package.json");
		const packageJsonExists = await fileExists(packageJsonPath);
		const packageJsonMerge = packageJsonExists
			? mergePackageJson(await readFile(packageJsonPath, "utf8"), projectName, options.cliVersion)
			: undefined;

		const gitignorePath = resolve(targetDirectory, ".gitignore");
		const gitignoreExists = await fileExists(gitignorePath);
		const existingGitignore = gitignoreExists ? await readFile(gitignorePath, "utf8") : "";
		const mergedGitignore = gitignoreExists ? mergeGitignore(existingGitignore) : REPOSITORY_GITIGNORE;

		const environmentExamplePath = resolve(targetDirectory, ".env.example");
		const environmentExampleExists = await fileExists(environmentExamplePath);
		const existingEnvironmentExample = environmentExampleExists ? await readFile(environmentExamplePath, "utf8") : "";
		const mergedEnvironmentExample = mergeEnvironmentExample(existingEnvironmentExample, config);

		if (packageJsonExists && packageJsonMerge) {
			if (packageJsonMerge.content !== (await readFile(packageJsonPath, "utf8"))) {
				await writeFile(packageJsonPath, packageJsonMerge.content, "utf8");
				updatedFiles.push("package.json");
			}
			preservedFiles.push(...packageJsonMerge.preservedSettings);
		} else {
			await writeFile(packageJsonPath, buildPackageJson(projectName, options.cliVersion), "utf8");
			createdFiles.push("package.json");
		}

		if (!gitignoreExists) {
			await writeFile(gitignorePath, mergedGitignore, "utf8");
			createdFiles.push(".gitignore");
		} else if (mergedGitignore !== existingGitignore) {
			await writeFile(gitignorePath, mergedGitignore, "utf8");
			updatedFiles.push(".gitignore");
		}

		if (!environmentExampleExists) {
			await writeFile(environmentExamplePath, mergedEnvironmentExample, "utf8");
			createdFiles.push(".env.example");
		} else if (mergedEnvironmentExample !== existingEnvironmentExample) {
			await writeFile(environmentExamplePath, mergedEnvironmentExample, "utf8");
			updatedFiles.push(".env.example");
		}

		const statePath = resolve(targetDirectory, "agents.state.json");
		if (await fileExists(statePath)) {
			preservedFiles.push("agents.state.json");
		} else {
			await writeFile(statePath, INITIAL_STATE, "utf8");
			createdFiles.push("agents.state.json");
		}

		await mkdir(resolve(targetDirectory, ".aoneci"), { recursive: true });
		const workflowPath = resolve(targetDirectory, ".aoneci/openagentpack.yml");
		if (await fileExists(workflowPath)) {
			preservedFiles.push(".aoneci/openagentpack.yml");
		} else {
			await writeFile(workflowPath, buildAoneWorkflow(config), "utf8");
			createdFiles.push(".aoneci/openagentpack.yml");
		}
		const checkWorkflowPath = resolve(targetDirectory, ".aoneci/openagentpack-check.yml");
		if (await fileExists(checkWorkflowPath)) {
			preservedFiles.push(".aoneci/openagentpack-check.yml");
		} else {
			await writeFile(checkWorkflowPath, buildAoneCheckWorkflow(config), "utf8");
			createdFiles.push(".aoneci/openagentpack-check.yml");
		}

		const readmePath = resolve(targetDirectory, "README.md");
		if (await fileExists(readmePath)) {
			preservedFiles.push("README.md");
		} else {
			await writeFile(readmePath, buildReadme(projectName, config), "utf8");
			createdFiles.push("README.md");
		}
		preservedFiles.push("agents.yaml");
	}

	if (shouldInitializeGit) await initializeGitRepository(targetDirectory);
	return {
		targetDirectory,
		mode: targetMode === "new" ? "created" : "upgraded",
		initializedGit: shouldInitializeGit,
		createdFiles,
		updatedFiles,
		preservedFiles,
	};
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

export async function initCommand(options: InitCommandOptions, cliVersion: string) {
	const directory = options.git;
	const repositoryMode = directory !== undefined;
	const configPath = "agents.yaml";

	if (!repositoryMode && (await fileExists(configPath))) {
		log.warn(`${configPath} already exists, skipping.`);
		return;
	}

	p.intro("agents init", { output: process.stderr });

	if (repositoryMode) {
		const targetMode = await inspectProjectTarget(resolve(directory));
		const answers = targetMode === "new" ? await promptForProjectOptions(options) : undefined;
		if (targetMode === "existing" && (options.provider || options.agentName)) {
			p.log.warn("Existing agents.yaml found; --provider and --agent-name were ignored.", {
				output: process.stderr,
			});
		}
		const result = await createGitProject(directory, {
			...answers,
			cliVersion,
		});
		const action = result.mode === "created" ? "Created Aone-ready project" : "Added Git scaffolding";
		p.log.success(`${action} at ${result.targetDirectory}`, { output: process.stderr });
		if (result.preservedFiles.length > 0) {
			p.log.warn(`Preserved existing content: ${result.preservedFiles.join(", ")}`, {
				output: process.stderr,
			});
		}
		p.outro("Done! Add credentials to .env, run npm install, then open the Workbench.", {
			output: process.stderr,
		});
		return;
	}

	const answers = await promptForProjectOptions(options);
	const template = buildTemplate(answers);
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

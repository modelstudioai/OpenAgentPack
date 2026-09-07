export const RESOURCE_EXAMPLES_DIRECTORY = "_examples";

/** Inert examples; resource discovery never traverses the reserved _examples directory. */
export function directoryProjectScaffold(): Record<string, string> {
	const agentRoot = "agents/assistant";
	const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
	return {
		"project.json": json({ version: "1" }),
		[`${agentRoot}/agent.json`]: json({
			name: "Assistant",
			model: "qwen3.7-max",
		}),
		[`${agentRoot}/instructions.md`]: "You are a helpful assistant.\n",
		[`${agentRoot}/skills/${RESOURCE_EXAMPLES_DIRECTORY}/example-skill/skill.json`]: json({
			id: "example-skill",
			name: "Example Skill",
			description: "Summarize user-provided text. / 总结用户提供的文本。",
		}),
		[`${agentRoot}/skills/${RESOURCE_EXAMPLES_DIRECTORY}/example-skill/SKILL.md`]: `---
name: example-skill
description: Summarize user-provided text into concise key points. 总结用户提供的文本。
---

# Summarize text / 文本总结

Use this Skill when the user asks to summarize text.
用户要求总结文本时，使用此 Skill。

1. Read the provided text. / 阅读用户提供的文本。
2. Extract the main ideas without adding unsupported facts. / 提炼要点，不添加未经支持的事实。
3. Respond in the user's language with a brief summary. / 使用用户的语言给出简短总结。
`,
		[`${agentRoot}/skills/${RESOURCE_EXAMPLES_DIRECTORY}/example-skill/README.md`]: `# Skill example / Skill 配置示例

- \`skill.json\` defines the resource ID and display fields. Keep its \`id\` unique across the project.
  \`skill.json\` 声明资源 ID 和展示字段，ID 在项目的 Skill 中必须唯一。
- \`SKILL.md\` contains the Skill instructions. Put scripts/assets in this same directory if needed;
  the directory is the upload source. Do not put secrets in these files.
  \`SKILL.md\` 是 Skill 指令，需要的脚本和素材也放在此目录；整个目录作为上传源，请勿放入密钥。
- This example is ignored by Build/Publish. Copy it from \`skills/_examples/example-skill/\`
  to \`skills/example-skill/\`, then add \`"skills": ["example-skill"]\` to \`agent.json\`.
  此示例不参与构建/发布。复制到 \`skills/example-skill/\` 后，再在 Agent 中添加上述引用。
- To add another Skill, copy this directory, change the directory name and \`skill.json.id\`,
  then add its ID to \`agent.json.skills\`. A new directory with only \`SKILL.md\` is also discovered by Build.
  新增 Skill 时复制此目录、修改目录名和 ID，再在 Agent 中引用；只放 \`SKILL.md\` 的新目录也能由 Build 自动关联。
- Delete this ignored example directory if not needed. For an enabled Skill, also remove its Agent reference.
  不需要时可直接删除本示例目录；若已经启用，还需删除 Agent 引用。
`,
		[`${agentRoot}/files/${RESOURCE_EXAMPLES_DIRECTORY}/example-file/file.json`]: json({
			id: "example-file",
			name: "example.md",
			source: "./example.md",
		}),
		[`${agentRoot}/files/${RESOURCE_EXAMPLES_DIRECTORY}/example-file/example.md`]: `# Example reference / 示例参考文件

Replace this file with the reference material your Agent needs.
请将此文件替换为 Agent 需要的参考资料。

This is an ignored example. After you explicitly enable it, configure a new-Session mount
at \`/mnt/example.md\` in agent.json.
这是未启用的示例。显式启用后，可在 agent.json 中配置新 Session 的挂载路径 \`/mnt/example.md\`。
`,
		[`${agentRoot}/files/${RESOURCE_EXAMPLES_DIRECTORY}/example-file/README.md`]: `# File example / File 配置示例

- \`file.json\` is metadata; \`example.md\` is the content uploaded by Publish.
  \`file.json\` 是元数据；Publish 上传的是 \`example.md\` 内容，不是本 README。
- \`source\` is relative to this resource directory. Keep \`id\` equal to the directory name.
  \`source\` 相对此资源目录解析，\`id\` 应与目录名一致。
- Build/Publish ignore this example. Copy \`files/_examples/example-file/\` to \`files/example-file/\`
  to enable its declaration; add \`"files": [{"file": "example-file", "mount_path": "/mnt/example.md"}]\` to \`agent.json\`.
  此示例不参与构建/发布。复制到 \`files/example-file/\` 后启用声明，再添加上述挂载引用；挂载路径必须在 \`/mnt/\` 下。
- Uploading a File does not permanently attach it to the remote Agent. These declarations
  supply default mounts for new Sessions; existing Sessions are unchanged.
  上传 File 不等于永久绑定到远端 Agent；这里声明的是新 Session 的默认挂载，不修改已有 Session。
- Build can also infer metadata and an Agent mount for a file placed directly in the parent
  \`files/\` directory, or a resource directory containing exactly one content file.
  在上级 \`files/\` 直接放文件，或在新资源目录中只放一个内容文件，Build 也会自动生成元数据和挂载引用。
- Delete this ignored example directory if not needed. For an enabled File, also remove its Agent reference.
  不需要时可直接删除本示例目录；若已经启用，还需删除 Agent 中的 File 引用。
`,
		[`${agentRoot}/vaults/${RESOURCE_EXAMPLES_DIRECTORY}/example-vault/vault.json`]: json({
			id: "example-vault",
			display_name: "Example Vault",
			credentials: [
				{
					name: "service-token",
					type: "environment_variable",
					secret_name: "SERVICE_TOKEN",
					secret_value: "$" + "{SERVICE_TOKEN}",
				},
			],
		}),
		[`${agentRoot}/vaults/${RESOURCE_EXAMPLES_DIRECTORY}/example-vault/README.md`]: `# Vault example / Vault 配置示例

Build/Publish ignore this directory; no example secret is required to open Workbench.
Copy \`vaults/_examples/example-vault/\` to \`vaults/example-vault/\` to enable the declaration,
then add \`"vault": "example-vault"\` to \`agent.json\` and supply the secret.
此示例不参与构建/发布，不需要配置密钥即可打开 Workbench。
启用时，复制到 \`vaults/example-vault/\`，在 Agent 中添加上述引用，并配置密钥。

The example \`vault.json\` contains:
示例 \`vault.json\` 的完整配置如下：

\`\`\`json
${JSON.stringify(
	{
		id: "example-vault",
		display_name: "Example Vault",
		credentials: [
			{
				name: "service-token",
				type: "environment_variable",
				secret_name: "SERVICE_TOKEN",
				secret_value: "$" + "{SERVICE_TOKEN}",
			},
		],
	},
	null,
	2,
)}
\`\`\`

- \`name\` identifies the credential; \`secret_name\` is the environment variable exposed to the runtime.
  \`secret_value\` references a local environment variable. The two variable names may differ.
  \`name\` 是凭据名称；\`secret_name\` 是运行时的变量名；\`secret_value\` 引用本地环境变量，两者可以不同。
- Provide \`SERVICE_TOKEN\` in the process environment or project-root \`.env\` before runtime/Publish.
  使用前在进程环境或项目根目录 \`.env\` 中配置 \`SERVICE_TOKEN\`，不要将真实值写入本 README。
- If you put a literal secret in \`vault.json\`, Build moves it to project-root \`.env\`
  and replaces the JSON value with an environment reference. Preview/dry-run do not write it.
  若在 \`vault.json\` 写入明文，Build 会将其移入项目根目录 \`.env\` 并写回变量引用；预览不会写文件。
- \`.env\` is plaintext with owner-only permissions when created by Build. It is excluded from local
  version snapshots, not automatically Git-ignored. Back it up securely and add it to your Git ignore rules.
  \`.env\` 仍是本地明文文件；Build 创建时仅文件所有者可读写。它不进入本地版本快照，请安全备份并自行加入 Git 忽略规则。
- Never put real credentials into ignored examples: example files are still local versioned source.
  Do not put secrets into this README. Only enabled Vault declarations participate in Build secret migration.
  不要在示例或 README 中放入真实密钥：示例仍属于本地版本源文件。只有已启用的 Vault 声明会参与 Build 密钥迁移。
- Delete this ignored example directory if not needed. For an enabled Vault, also remove \`agent.json.vault\`.
  不需要时可直接删除本示例目录；若已经启用，还需删除 Agent 的 \`vault\` 字段。
`,
		[`${agentRoot}/environments/${RESOURCE_EXAMPLES_DIRECTORY}/example-env/environment.json`]: json({
			id: "example-env",
			name: "Example Environment",
			config: { type: "cloud" },
		}),
		[`${agentRoot}/environments/${RESOURCE_EXAMPLES_DIRECTORY}/example-env/README.md`]: `# Environment example / Environment 配置示例

- This is an ignored managed cloud environment example. Copy \`environments/_examples/example-env/\`
  to \`environments/example-env/\` to enable it, then add \`"environment": "example-env"\` to \`agent.json\`.
  这是不参与构建/发布的托管云环境示例。复制到 \`environments/example-env/\` 后启用，再在 Agent 中添加上述引用。
  Keep \`id\` equal to the directory name. / ID 应与目录名一致。
- Optional \`config\` fields include \`networking\`, \`packages\`, and \`setup_script\`.
  \`config\` 可按需增加网络策略、依赖包和初始化脚本，例如：

\`\`\`json
${JSON.stringify({ type: "cloud", packages: { pip: ["requests"] }, setup_script: "echo 'Environment ready'" }, null, 2)}
\`\`\`

- The snippet replaces only \`config\`. Build validates declarations locally;
  packages/scripts take effect on the remote platform, not on your computer during Init/Build.
  上面的片段只替换 \`config\`。Init/Build 不会在本机安装依赖或执行脚本；远端是否支持以 Provider 为准。
- Init leaves \`agent.json\` unchanged and only creates ignored resource examples.
  Moving a declaration outside \`_examples/\` enables it for Build/Publish, even without an Agent reference.
  Init 不添加 Agent 资源引用。将声明移到 \`_examples/\` 外即会进入构建/发布范围，即使尚未配置 Agent 引用。
- Delete this ignored example directory if not needed. For an enabled Environment, also remove its Agent reference.
  不需要时可直接删除本示例目录；若已经启用，还需删除 Agent 的 Environment 引用。
`,
	};
}

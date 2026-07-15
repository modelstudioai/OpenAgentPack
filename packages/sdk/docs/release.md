# 发布流程

本文档说明 `@openagentpack/sdk`、`@openagentpack/playground` 和 `@openagentpack/cli` 的发布流程。

## 发布原则

- npm 包的首次 bootstrap 与后续正式发布都只从 GitHub 仓库 [`modelstudioai/OpenAgentPack`](https://github.com/modelstudioai/OpenAgentPack) 的 `.github/workflows/release.yml` 执行。
- GitHub Actions 使用 npm Trusted Publishing（OIDC），不保存长期写权限 `NPM_TOKEN`。
- 发布前必须通过 `bun run verify:release`，其中包含完整校验、包构建、`npm publish --dry-run`，以及真实 tarball 的外部消费者安装与运行 smoke。
- npm 包按 `sdk → playground → cli` 的拓扑顺序发布。

## 首次发布与一次性配置

npm 只允许为**已经存在**的包配置 Trusted Publisher。三个包首次发布前，创建一个仅用于 bootstrap 的 npm granular access token（允许创建并发布 `@openagentpack/*` 公共包），保存为 GitHub Actions secret `NPM_TOKEN`。首次发布仍由 `release.yml` 执行，并显式启用 provenance；不要在本地开发机直接发布首版。

仓库默认不定义 Actions 变量 `NPM_RELEASE_ENABLED`，因此开源审核期间即使 workflow 文件进入 `main` 也不会发布。审核通过并完成 GitHub 保护设置后，将该变量设为 `true`，再手动 dispatch Release workflow 完成首次发布。此后保留该变量，日常发布继续由 `main` push 驱动。

首次发布成功后，立即执行以下步骤：

在 npmjs.com 上分别打开三个包的设置，把 Trusted Publisher 配置为：

| 字段 | 值 |
|---|---|
| Provider | GitHub Actions |
| Organization | `modelstudioai` |
| Repository | `OpenAgentPack` |
| Workflow filename | `release.yml` |
| Allowed action | `npm publish` |

Trusted Publishing 要求 npm CLI 11.5.1+ 和 Node.js 22.14+。Release workflow 使用 Node.js 24 和固定版本的 npm CLI，并授予 `id-token: write`。

配置完成后：

1. 从 GitHub Actions secrets 删除 `NPM_TOKEN`；
2. 在 npm 撤销 bootstrap token；
3. 将三个包的 Publishing access 设置为要求 2FA 并禁止传统 token；
4. 触发下一次 beta 发布，确认 npm 页面显示来自 `release.yml` 的 provenance。

此后 workflow 中空的 `NODE_AUTH_TOKEN` 不参与认证，npm 使用 GitHub OIDC。不要为日常发布重新创建长期 token。

## 日常发布

在功能 PR 中创建 changeset：

```bash
bun run changeset
```

合并到 `main` 后，Release workflow 会：

1. 创建或更新版本 PR；
2. 在版本 PR 合并后运行完整发布校验；
3. 更新版本与 changelog；
4. 使用 OIDC 发布三个 npm 包，并自动生成 provenance。

## 本地校验

本地不执行正式发布，只验证将要发布的内容：

```bash
bun run verify:release
```

也可以单独检查发布包：

```bash
bun run build:packages
bun run release:publish -- --dry-run --tag beta
```

发布脚本会临时完成三件事，并在 `finally` 中恢复工作区：

- 把开发期的 `./src/*.ts` exports 重写为发布用的 `./dist/*.js`；
- 把 `workspace:` 依赖解析为对应工作区包的实际版本，避免把工作区协议发布给 npm 消费者；
- 把仓库根目录的 Apache-2.0 `LICENSE` 放入每个 npm tarball。

随后 package smoke 会用 `--engine-strict` 把三个 tarball 安装到临时空项目，导入 SDK 的所有公开入口、执行 `agents --version`，并启动 Playground 验证其 HTML shell。CI 在 Node.js 20 和 24 上各运行一次，因此包的 `engines` 声明和传递依赖要求必须同时成立。

真实发布会先查询每个精确包版本；版本已经存在时会跳过，因此三个包中途发布失败后可以安全重跑。预发布版本会从 SemVer 标识自动推导 npm dist-tag（例如 `1.0.1-beta.5` 使用 `beta`），避免占用 `latest`。Release workflow 禁止 `cancel-in-progress`，避免新 push 在发布中途取消任务。

## Beta / 预发布

```bash
bunx changeset pre enter beta
bun run changeset
```

版本 PR 合并后，预发布版本使用 `beta` dist-tag。预发布阶段结束时执行：

```bash
bunx changeset pre exit
```

## 故障排除

### `ENEEDAUTH`

首次发布时确认临时 `NPM_TOKEN` secret 存在且允许创建 scoped public package。后续发布则确认 npm Trusted Publisher 中的 organization、repository 和 workflow filename 与本页完全一致，并确认 workflow 具有 `id-token: write`。

### 包内容不完整

运行 `bun run verify:release`，检查 dry-run 输出中是否同时包含 `README.md`、`LICENSE`、`package.json` 和构建后的 `dist/`。

### 本地 package.json 或 LICENSE 残留改动

正常退出时发布脚本会自动恢复。如果进程被强制终止，检查工作区并仅移除发布脚本临时生成的包内 `LICENSE` 文件。

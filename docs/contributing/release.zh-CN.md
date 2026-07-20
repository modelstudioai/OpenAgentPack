# npm 发布流程

OpenAgentPack 将 `@openagentpack/sdk`、`@openagentpack/playground` 和 `@openagentpack/cli` 作为同一版本组发布。真实发布只能在 GitHub Actions 中执行；本地只能构建和 dry-run，不能把包发布到 npm。

## 一次性配置

组织管理员需要先在组织的 Actions 设置中允许 GitHub Actions 创建 Pull Request，再在 **仓库 Settings → Actions → General** 打开对应选项。Release PR 工作流使用仓库自带的 `GITHUB_TOKEN`，不需要个人 token。

然后创建名为 `npm-release` 的 Environment，并配置 Required reviewers，让每次 npm 发布都必须由维护者批准。不要在这个 Environment 中保存 npm token。GitHub 可能只会在仓库公开后，或符合条件的私有仓库套餐中开放审批规则。

在 npmjs.com 分别进入三个包的设置，为每个包配置相同的 Trusted Publisher：

| npm 配置项 | 值 |
|---|---|
| Provider | GitHub Actions |
| Organization | `modelstudioai` |
| Repository | `OpenAgentPack` |
| Workflow filename | `release.yml` |
| Environment | `npm-release` |

工作流使用 GitHub-hosted runner、Node.js 24、npm 12、`id-token: write` 和 provenance，不需要 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。npm 只允许为已存在的包配置 Trusted Publisher。

只有 Trusted Publisher 和 Environment 审批人全部配置完成后，才创建值为 `true` 的仓库 Actions variable `NPM_RELEASE_ENABLED`。如果这个变量不存在，即使有人手动运行工作流，发布 job 也会被跳过。

## 每个功能 PR 要做什么

只要改动会影响用户使用的 npm 包，就在 PR 中添加 changeset：

```bash
bun run changeset
```

选择 SemVer 影响范围并填写 changelog。PR 合并后，**Release PR** 工作流会在 `main` 上创建或更新稳定版版本 PR。只有合并该 Release PR 才会自动启动正式发布，并且发布仍需 `npm-release` Environment 审批。

## 发布 Beta

1. 打开 GitHub 的 **Actions → Publish npm → Run workflow**。
2. workflow branch 保持 `main`，channel 选择 `beta`，输入 `PUBLISH`，然后运行。
3. 检查提交、自动生成的精确版本和 job 信息后，批准 `npm-release` Environment deployment。

工作流根据 GitHub Actions run ID 和 `main` 当前提交生成不修改 Git 历史的版本，例如 `0.0.0-beta.run-123456789.sha-a1b2c3d`。通过后使用 npm 的 `beta` dist-tag 发布，并创建对应的不可变 Git tag。随后，它会在 Linux、Windows、macOS 的 Node.js 22 和 24 环境中，从公共 npm registry 安装该精确版本。只有六个消费者 job 全部通过，才创建 GitHub prerelease。

需要下一个 Beta 时，把修复合并到 `main` 后再次运行 **Publish npm**。每次运行都会根据 Actions run ID 和提交生成新的不可变版本，不需要 Beta 分支，也不会消费 changeset。

## 发布稳定版

1. 审核并合并自动生成的 `chore: release packages` PR。
2. 合并提交到达 `main` 后，**Publish npm** 会自动启动。
3. 检查准确版本后，批准 `npm-release` Environment deployment。

如果发布中途失败，可在 **Actions → Publish npm → Run workflow** 中选择 `main`、channel `stable`，输入 `PUBLISH` 手动重跑。已经成功发布的精确包版本会被跳过。

只有 `main` 上不含预发布后缀的 `X.Y.Z` 才能发布到 npm 的 `latest`。发布后会创建对应的不可变 Git tag，等待三个包在公共 registry 中全部可见，再执行六个消费者 job。正式 GitHub Release 是最后的发布认证，只有矩阵全部通过后才创建。发布过程可安全重试：已经存在的精确包版本会被跳过。

## 发布后消费者验证

`npm publish` 返回成功并不代表 release 已完成。工作流还必须证明一个全新的外部消费者可以从 npm 安装并执行公开包：

| Runner | 必测 Node.js 版本 |
|---|---|
| Ubuntu | 22、24 |
| Windows | 22、24 |
| macOS | 22、24 |

每个矩阵 job 都会独立安装精确版本，验证 npm registry 签名和 provenance，加载 SDK 的所有公开入口，执行 CLI help/version/离线 validate，并通过 HTTP 启动 Playground。验证过程不会使用 workspace 包、本地 tarball 或 publish job 的构建产物。

`Package compatibility canary` 工作流还会在每周三使用三个操作系统和 Node.js 26 验证 npm 的 `latest` 版本。Canary 失败不会影响已经完成的 release，但应在 Node.js 26 进入正式 LTS 支持矩阵前完成处置。

## 本地验证

```bash
bun run verify:release
```

它会运行完整仓库检查、构建包、执行不依赖 registry 版本状态的 `npm pack --dry-run`，并以全新外部消费者的方式安装 tarball。CI 会在 Node.js 22 和 24 下执行这项 package smoke。只检查 tarball 时可以运行：

```bash
bun run build:packages
bun run release:publish -- --dry-run
```

发布脚本会阻止在 GitHub Actions 以外执行真实发布。

## 用户如何安装

```bash
# 稳定版 CLI（npm latest）
npm install --global @openagentpack/cli

# Beta CLI（npm beta）
npm install --global @openagentpack/cli@beta

# 固定或临时体验某个精确 Beta 版本
npx @openagentpack/cli@0.0.0-beta.run-123456789.sha-a1b2c3d --version

# SDK
npm install @openagentpack/sdk
```

安装 CLI 后运行 `agents --help`。Beta 用户可用 `npm install --global @openagentpack/cli@latest` 切回稳定版。

## 故障恢复

- npm 认证失败：逐字检查 Trusted Publisher 的仓库、workflow 文件名和 Environment 是否与上表一致。
- 部分包成功、部分包失败：从同一个提交重新运行同一个工作流，已发布的精确版本会被跳过。
- 所有包都已发布，但发布后消费者 job 失败：保留不可变 tag，不执行 unpublish、不移动 tag，也不创建 GitHub Release。修复兼容性问题后发布新的 patch 版本；npm 上的版本不能被覆盖。
- registry 可见性会重试五分钟，之后才判定 release 失败。只有确认失败原因是 npm 同步延迟而不是包兼容性时，才从同一个提交重试。
- 版本 tag 已指向其他提交：立即停止。tag 必须保持不可变，应排查历史，不能移动或删除 tag。
- Beta 发布必须从 `main` 手动触发；其他分支会被发布身份检查拒绝。

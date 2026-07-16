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

选择 SemVer 影响范围并填写 changelog。PR 合并后，**Release PR** 工作流会在 `main` 上创建或更新稳定版版本 PR，但绝不会直接发布 npm 包。

## 发布 Beta

1. 打开 GitHub 的 **Actions → Prepare Beta Release → Run workflow**。
2. workflow branch 保持 `main`，输入目标稳定版系列，例如 `0.1.0`，然后运行。
3. 工作流会创建或更新 `release/0.1.0-beta`，消费现有 changeset，并提交下一个版本，例如 `0.1.0-beta.0`。
4. 打开 **Actions → Publish npm → Run workflow**。
5. 在 workflow branch 下拉框选择 `release/0.1.0-beta`，channel 选择 `beta`，输入 `PUBLISH`，然后运行。
6. 检查提交和 job 信息后，批准 `npm-release` Environment deployment。

发布工作流会同时校验分支、包版本和 channel。通过后使用 npm 的 `beta` dist-tag 发布，创建不可变的 `v0.1.0-beta.N` Git tag，并创建 GitHub prerelease。

需要下一个 Beta 时，把修复及其 changeset 合并到 `main`，再对同一个版本系列运行 **Prepare Beta Release**。工作流会把 `main` 合入 Beta 分支并计算下一个 Beta。不要把 Beta 分支反向合并到 `main`；稳定版发布后删除它。

## 发布稳定版

1. 审核并合并自动生成的 `chore: release packages` PR。
2. 打开 **Actions → Publish npm → Run workflow**。
3. 选择 `main`，channel 选择 `stable`，输入 `PUBLISH`，然后运行。
4. 检查准确版本后，批准 `npm-release` Environment deployment。

只有 `main` 上不含预发布后缀的 `X.Y.Z` 才能发布到 npm 的 `latest`。成功后会创建对应的不可变 Git tag 和正式 GitHub Release。发布过程可安全重试：已存在的精确包版本会被跳过。

## 本地验证

```bash
bun run verify:release
```

它会运行完整仓库检查、构建包、执行 `npm publish --dry-run`，并把 tarball 安装进干净的 Node.js 20/24 消费者项目。只检查 tarball 时可以运行：

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

# 固定或临时体验某个精确版本
npx @openagentpack/cli@0.1.0-beta.0 --version

# SDK
npm install @openagentpack/sdk
```

安装 CLI 后运行 `agents --help`。Beta 用户可用 `npm install --global @openagentpack/cli@latest` 切回稳定版。

## 故障恢复

- npm 认证失败：逐字检查 Trusted Publisher 的仓库、workflow 文件名和 Environment 是否与上表一致。
- 部分包成功、部分包失败：从同一个提交重新运行同一个工作流，已发布的精确版本会被跳过。
- 版本 tag 已指向其他提交：立即停止。tag 必须保持不可变，应排查历史，不能移动或删除 tag。
- **Prepare Beta Release** 提示没有未发布 changeset：先在 `main` 添加 changeset，再准备下一个 Beta。

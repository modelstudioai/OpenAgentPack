#!/bin/sh
# 激活本仓 git hooks:把 core.hooksPath 指向 .githooks/(repo-local,不动全局)。
# 克隆后跑一次即可:  sh scripts/setup-githooks.sh

# 云构建环境或非 git 仓库中静默跳过
if [ -n "$BUILD_ARGV_STR" ] || ! git rev-parse --git-dir > /dev/null 2>&1; then
  exit 0
fi

root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
chmod +x .githooks/* 2>/dev/null
git config core.hooksPath .githooks
echo "已设 core.hooksPath=.githooks(本仓)。pre-commit 跑 lint:changed; pre-push 跑 verify:push; commit-msg 转发全局校验。"

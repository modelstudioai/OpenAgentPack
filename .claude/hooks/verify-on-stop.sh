#!/usr/bin/env bash
# Stop hook:统一 verification harness 的 scoped profile；失败 exit 2 回灌输出。
set -uo pipefail

if ! command -v bun >/dev/null 2>&1; then
	for d in "$HOME/.bun/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
		[ -x "$d/bun" ] && PATH="$d:$PATH"
	done
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

out=$(bun run verify:scoped 2>&1) || {
	{
		echo "verify:scoped 未通过，修好再停。最后 80 行输出："
		echo "$out" | tail -n 80
	} >&2
	exit 2
}

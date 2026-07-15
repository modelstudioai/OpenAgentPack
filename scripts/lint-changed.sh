#!/usr/bin/env bash
# scoped check 单一真源:对改动文件跑 `biome check`(lint + format + import 排序),按严重度分流:
#   - error 级(format / assist organizeImports / lint error):baseline = 0(CI 的 `bun run lint`
#     = `biome check .` 当前零 error),故任何 error 都是新增 → 整文件级拦截,与 CI 完全同源。
#     必须整文件:format/import-sort 的诊断落在 import 块/文件首,未必在你编辑的那一行。
#   - warning 级:历史 warning 不拦；改动行或新增文件中的 warning 视为新增并阻断。
#     full profile 与 CI 都调用本脚本，因此 baseline policy 在所有入口一致。
# 为何不用 `biome lint`:它不含 formatter 与 assist(import 排序),会放行 CI 仍会红的改动(闸门口径缺口)。
# 被两端共用:.claude/hooks/verify-on-stop.sh(工作区 vs HEAD)与 .githooks/pre-push(推送范围,传 BASE)。
# 用法: scripts/lint-changed.sh              # 工作区改动 vs HEAD + untracked(整文件算新增)
#        BASE=<sha> scripts/lint-changed.sh  # 比对 BASE...HEAD 的提交改动
# 注意: macOS 默认 bash 3.2,勿用 mapfile / declare -A。
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 0

EXTS='[.](ts|tsx|js|jsx|cjs|mjs|json)$'

# STAGED=1 表示 pre-commit 场景：只检查暂存区（git diff --cached），不检查未跟踪文件。
CACHED_FLAG=""
[ "${STAGED:-}" = "1" ] && CACHED_FLAG="--cached"

if [ -n "${BASE:-}" ] && ! echo "$BASE" | grep -qE '^0+$'; then
  if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
    echo "lint:changed: BASE '$BASE' 不是可用 commit。" >&2
    exit 2
  fi
  tracked=$(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD 2>/dev/null)
  untracked=""
  if [ "${INCLUDE_WORKTREE:-}" = "1" ]; then
    tracked="$tracked
$(git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null)"
    untracked=$(git ls-files --others --exclude-standard 2>/dev/null)
  fi
else
	BASE=""
  tracked=$(git diff $CACHED_FLAG --name-only --diff-filter=ACMR HEAD 2>/dev/null)
  if [ "${STAGED:-}" = "1" ]; then
    untracked=""
  else
    untracked=$(git ls-files --others --exclude-standard 2>/dev/null)
  fi
fi
files=$( { echo "$tracked"; echo "$untracked"; } | grep -E "$EXTS" | sort -u )
[ -z "$files" ] && exit 0

changed_lines=$(mktemp)
wholefile=$(mktemp)
trap 'rm -f "$changed_lines" "$wholefile"' EXIT

# 每个文件的新增行 → "path:line";untracked 文件整体算新增(记入 wholefile)。
for f in $files; do
  [ -f "$f" ] || continue
  if echo "$untracked" | grep -qxF "$f"; then
    echo "$f" >> "$wholefile"
    continue
  fi
  if [ -n "${BASE:-}" ]; then
    diff_out=$(git diff --unified=0 "$BASE"...HEAD -- "$f" 2>/dev/null)
    if [ "${INCLUDE_WORKTREE:-}" = "1" ]; then
      diff_out="$diff_out
$(git diff --unified=0 HEAD -- "$f" 2>/dev/null)"
    fi
  else
    diff_out=$(git diff $CACHED_FLAG --unified=0 HEAD -- "$f" 2>/dev/null)
  fi
  # hunk 头 @@ -a,b +c,d @@:取 +c,d → 新增行 c..c+d-1(纯删除 d=0,不产生新行)。
  echo "$diff_out" | awk -v path="$f" '
    /^@@/ {
      plus=$3; sub(/^\+/,"",plus)
      n=split(plus,a,",")
      start=a[1]+0; cnt=(n>1?a[2]+0:1)
      for(i=0;i<cnt;i++) print path":"(start+i)
    }' >> "$changed_lines"
done

# biome json:每条 diagnostic → "path:line\tseverity\tcategory"。
# 用 `biome check`(含 lint + format + assist),口径与 CI 的 `bun run lint` 一致。
diag=$(echo "$files" | xargs bun run biome check --reporter=json 2>/dev/null \
  | jq -r '.diagnostics[] | "\(.location.path):\(.location.start.line)\t\(.severity)\t\(.category)"' 2>/dev/null)
[ -z "$diag" ] && exit 0

fail=0
err_out=""
warn_out=""
while IFS=$'\t' read -r loc sev cat; do
  [ -z "$loc" ] && continue
  path=${loc%:*}
  if [ "$sev" = "error" ]; then
    # error 零 baseline → 整文件级拦,与 CI 硬墙(biome check . 因 error 退出非 0)同源。
    err_out="$err_out  $sev  $loc  $cat"$'\n'
    fail=1
  elif grep -qxF "$path" "$wholefile" 2>/dev/null || grep -qxF "$loc" "$changed_lines" 2>/dev/null; then
    # 历史 warning 不拦；改动行或新增文件中的 warning 属于新增债务。
    warn_out="$warn_out  $sev  $loc  $cat"$'\n'
    fail=1
  fi
done <<EOF
$diag
EOF

if [ -n "$warn_out" ]; then
  {
    echo "lint:changed 发现新增 warning（历史 warning 不受影响）："
    printf '%s' "$warn_out"
  } >&2
fi

if [ "$fail" -ne 0 ]; then
  {
    echo "lint:changed 发现阻断诊断（error 或新增 warning）："
    printf '%s' "$err_out"
    echo "自动修复可修项: bun run biome check --write <file>"
  } >&2
  exit 1
fi
exit 0

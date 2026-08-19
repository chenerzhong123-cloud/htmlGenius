#!/usr/bin/env bash
# release-check.sh — 合并/推送 main 的规范校验(单一事实源,Claude Code hook 与手动共用)
#
# 子命令:
#   push                推 main 前的完整检查(阻断项失败 → exit 2)
#   claude-pre-push     Claude Code PreToolUse 入口:从 stdin JSON 取 tool_input.command,
#                       仅当是 "git push … main" 时执行 push 检查(exit 2 = 拦截该工具调用)
#   claude-post-push    Claude Code PostToolUse 入口:push main 成功后注入收尾提醒
#                       (删已合并分支 / 部署 server 变更 / 发版打包)
#   check-docs <ver>    只查文档同步(RELEASE_NOTES 顶部条目 + README 最近更新),可测性入口
#
# 逃生门:HG_SKIP_RELEASE_CHECK=1(紧急热修;请在提交信息里说明原因)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || .)"

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; RST=$'\033[0m'
fail() { echo "${RED}[release-check] $*${RST}" >&2; exit 2; }
note() { echo "${YEL}[release-check] 提醒: $*${RST}" >&2; }

manifest_version() { python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])"; }

# --- 阻断:文档同步(版本号必须在两处文档中出现) ---
check_docs() {
  local ver="${1:-$(manifest_version)}"
  [[ -z "$ver" ]] && fail "无法读取 extension/manifest.json 的版本号"
  if ! head -40 RELEASE_NOTES.md | grep -q "## v${ver}[（(]"; then
    fail "RELEASE_NOTES.md 顶部 40 行内没有「## v${ver}(」条目 —— 推 main 前必须同步用户向文档(见 CLAUDE.md 发版规范)"
  fi
  if ! grep -q "v${ver}" README.md; then
    fail "README.md 里找不到 v${ver}(「最近更新」段缺当前版本条目)"
  fi
  echo "${GRN}[release-check] 文档同步 ✓ (v${ver})${RST}" >&2
}

# --- 提醒:已并入 main 但未删除的分支 ---
merged_branches() {
  local b out=""
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
    [[ "$b" == "main" ]] && continue
    if git merge-base --is-ancestor "$b" main 2>/dev/null; then out="$out $b"; fi
  done
  echo "$out" | xargs echo
}

# --- 阻断:manifest.key 完整性(钉死开发扩展 ID 的公开值,坏 key = 所有未打包加载报错) ---
check_manifest_key() {
  local err; err=$(python3 - <<'PY'
import json, base64, sys
try:
    k = json.load(open('extension/manifest.json')).get('key')
    if not k:
        sys.exit("manifest.key 缺失(源 manifest 必须保留 key 钉死开发扩展 ID;只有 pack.sh 在打包副本里删它)")
    der = base64.b64decode(k, validate=True)
    if len(der) != 294:
        sys.exit(f"manifest.key DER 长度 {len(der)} 字节(应为 294)——疑似被改写/截断,与 git 历史比对恢复")
    sys.exit(0)
except SystemExit:
    raise
except Exception as e:
    sys.exit(f"manifest.key 非法(base64 解码失败): {e}")
PY
  )
  [[ -n "$err" ]] && fail "$err"
  echo "${GRN}[release-check] manifest.key 完整 ✓ (294 字节 DER)${RST}" >&2
}

cmd_push() {
  [[ "${HG_SKIP_RELEASE_CHECK:-}" == "1" ]] && { note "HG_SKIP_RELEASE_CHECK=1,跳过(请记得补规范动作)"; exit 0; }
  check_docs
  check_manifest_key
  local mb; mb=$(merged_branches)
  [[ -n "$mb" ]] && note "已并入 main 未清理的分支:${mb} —— 按「只留 main 一条长期线」约定,请 git branch -d + 删远端(收尾时把 gitignored 文档先搬出 worktree)"
  local range="origin/main..HEAD"
  if git diff --name-only "$range" 2>/dev/null | grep -q '^server/'; then
    note "本次包含 server/ 变更 —— 记得部署阿里云(tar over ssh + systemctl restart htmlgenius)并线上冒烟"
  fi
  if git diff --name-only "$range" 2>/dev/null | grep -q '^extension/'; then
    note "本次包含 extension/ 变更 —— 若是发版动作:确认版本号策略(分支停留/合并递增)与 scripts/pack.sh 打包"
  fi
  exit 0
}

cmd_claude_pre_push() {
  local tool_cmd; tool_cmd=$(python3 -c 'import json,sys
try: print(json.load(sys.stdin)["tool_input"]["command"])
except Exception: print("")')
  # 只拦截推 main 的 push(含 git push origin main / git push origin main x 等)
  echo "$tool_cmd" | grep -Eq '(^|[[:space:]])git([[:space:]]+[^&|;]*)?[[:space:]]+push' || exit 0
  echo "$tool_cmd" | grep -Eq '([[:space:]/]|\b)main\b' || exit 0
  cmd_push
}

cmd_claude_post_push() {
  local input; input=$(cat)
  local tool_cmd tool_resp
  tool_cmd=$(echo "$input" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["tool_input"]["command"])
except Exception: print("")')
  echo "$tool_cmd" | grep -Eq '(^|[[:space:]])git([[:space:]]+[^&|;]*)?[[:space:]]+push' || exit 0
  echo "$tool_cmd" | grep -Eq '([[:space:]/]|\b)main\b' || exit 0
  tool_resp=$(echo "$input" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_response",""))
except Exception: print("")')
  # 收尾清单注入上下文(机器可查的现查现报,仓库外事项列人工项)
  local mb range_s range_e msgs=()
  mb=$(merged_branches)
  [[ -n "$mb" ]] && msgs+=("已并入 main 未删除的分支:${mb} → 现在执行 git branch -d(远端一并删;worktree 先搬 gitignored 文档)")
  range_s=$(git diff --name-only origin/main..main 2>/dev/null | grep -c '^server/' || true)
  [[ "$range_s" != "0" && -n "$range_s" ]] && msgs+=("server/ 有变更 → 部署阿里云并冒烟")
  range_e=$(git diff --name-only origin/main..main 2>/dev/null | grep -c '^extension/' || true)
  [[ "$range_e" != "0" && -n "$range_e" ]] && msgs+=("extension/ 有变更 → 若为发版:按规范打包 dist + 商店声明核对")
  msgs+=("仓库外人工项(机器查不到):Chrome 商店数据声明 / 阿里云部署审批 / GA 资产")
  local joined; joined=$(printf '%s;' "${msgs[@]}")
  python3 -c "
import json,sys
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse',
  'additionalContext': 'push main 后收尾清单:' + sys.argv[1].rstrip(';').replace(';','; ')}}))" "$joined"
  exit 0
}

case "${1:-}" in
  push) cmd_push ;;
  claude-pre-push) cmd_claude_pre_push ;;
  claude-post-push) cmd_claude_post_push ;;
  check-docs) shift; check_docs "${1:-}" ;;
  *) echo "用法: release-check.sh {push|claude-pre-push|claude-post-push|check-docs <ver>}" >&2; exit 1 ;;
esac

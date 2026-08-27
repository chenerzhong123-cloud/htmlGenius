#!/usr/bin/env bash
# 埋点数据一键拉取(方案已固定,2026-08-27 起,勿再探索):
#   bash scripts/analytics-pull.sh             # 线上库报表(ssh aliyun,只读 SELECT,不拷库)
#   bash scripts/analytics-pull.sh --exclude hgcid_xxx  # 剔除自有/测试 client(线上/本地均可)
#   bash scripts/analytics-pull.sh <db路径>    # 本地 sqlite 库
#
# 数据链路:extension 侧栏埋点 → server /api/analytics → 阿里云 annotations.db 的
# analytics_events 表 → scripts/analytics-report.py 出报表(漏斗/留存/活跃/编辑时长/参数健康检查)。
# 线上 python3 < 3.7(无 fromisoformat),report.py 必须保持纯 stdlib,经 stdin 管道在服务器执行。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

REMOTE_HOST="${HG_ANALYTICS_HOST:-aliyun}"
REMOTE_DB="${HG_ANALYTICS_DB:-/root/htmlGenius/annotations.db}"

if [ $# -eq 0 ] || [ "$1" = "--exclude" ]; then
  exec ssh "$REMOTE_HOST" "python3 - $REMOTE_DB $*" < "$DIR/analytics-report.py"
else
  exec python3 "$DIR/analytics-report.py" "$@"
fi

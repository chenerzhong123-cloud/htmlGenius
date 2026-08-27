#!/usr/bin/env python3
"""analytics_events 报表:漏斗 / 留存 / 活跃 / 编辑时长。

用法(推荐一键,见 scripts/analytics-pull.sh):
  bash scripts/analytics-pull.sh             # 线上库(只读 SELECT)
  bash scripts/analytics-pull.sh local.db    # 本地库
  bash scripts/analytics-pull.sh --exclude hgcid_xxx,hgcid_yyy   # 剔除自有/测试 client
等价原始命令: ssh aliyun 'python3 - /root/htmlGenius/annotations.db' < scripts/analytics-report.py

口径说明(与 spec 一致):
- "用户" = 匿名 client_id,多 profile/重装偏大;
- 留存按事件时间(client_ts,缺失回落 created_at)的 UTC 日期;
- 编辑时长 = 同一 client 相邻 edit_start→edit_end(毫秒差取 [0, 6h] 区间,跨面板会话的错配丢弃)。
"""
import json
import sqlite3
import sys
from datetime import datetime, timedelta

FUNNEL = [
    ("panel_open", "打开侧栏"),
    ("edit_start", "进入编辑"),
    ("comment_create", "根评论"),
    ("task_open", "打开任务"),
    ("plan_request", "看计划"),
    ("plan_confirm", "确认计划"),
    ("task_send", "发送任务"),
    ("task_success", "候选成功"),
    ("task_accept", "应用候选"),
    ("login_start", "发起登录"),
    ("login_success", "登录成功"),
    ("login_failed", "登录失败"),
    ("join_workspace", "加入团队"),
    ("create_workspace", "创建团队"),
    ("workspace_switch", "切换团队"),
    ("invite_copied", "复制邀请"),
    ("reply_create", "回复评论"),
    ("others_comments_seen", "看到他人评论"),
    ("session_restore", "自动登录恢复"),
]


_TS_FORMATS = (
    "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
)


def _ts(row):
    """宽松 ISO 解析,归一化为 naive UTC(兼容无 fromisoformat/新 %z 的老 python)。
    失败返回 None。所有时间戳都来自客户端/服务器的 UTC,统一按 UTC 处理。"""
    v = (row["client_ts"] or row["created_at"] or "").strip()
    if not v:
        return None
    base = v.replace("Z", "")
    off = ""
    # 从尾部找 ±HH:MM / ±HHMM 偏移,拆出来
    for i in range(len(base) - 1, max(len(base) - 7, 0), -1):
        if base[i] in "+-":
            base, off = base[:i], base[i:]
            break
    for f in _TS_FORMATS:
        try:
            d = datetime.strptime(base, f)
        except ValueError:
            continue
        if off:
            try:
                sign = -1 if off[0] == "-" else 1
                digits = off[1:].replace(":", "")
                if len(digits) == 4:
                    d -= sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
                elif len(digits) == 2:
                    d -= sign * timedelta(hours=int(digits))
            except ValueError:
                pass
        return d
    return None


def main(db_path: str, exclude: set = frozenset()) -> None:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    rows = db.execute("SELECT client_id, seq, name, params_json, client_ts, created_at FROM analytics_events").fetchall()
    db.close()
    if not rows:
        print("analytics_events 表为空。")
        return
    if exclude:
        before = len(rows)
        # 按前缀匹配(完整 UUID 或其前缀均可)
        rows = [r for r in rows if not any(r["client_id"].startswith(x) for x in exclude)]
        print(f"(已剔除自有/测试 client {','.join(sorted(exclude))}:{before - len(rows)} 条事件)\n")
        if not rows:
            print("剔除后无剩余数据。")
            return
    parsed = []
    for r in rows:
        d = dict(r)
        d["ts"] = _ts(r)
        try:
            d["params"] = json.loads(d["params_json"] or "{}")
        except ValueError:
            d["params"] = {}
        parsed.append(d)
    rows = parsed

    clients = sorted({r["client_id"] for r in rows})
    dates = sorted({r["ts"].date() for r in rows if r["ts"]})
    print(f"# 埋点报表({dates[0]} → {dates[-1]})\n")
    print(f"总事件 {len(rows)} · 独立 client {len(clients)} · 天数 {len(dates)}\n")

    # ── 1. 漏斗(用户级) ─────────────────────────────────────────
    print("## 漏斗(用户级转化)\n")
    print("| 事件 | 次数 | 用户 | 用户占比(相对 panel_open) |")
    print("|---|---:|---:|---:|")
    base = len({r["client_id"] for r in rows if r["name"] == "panel_open"}) or 1
    for name, label in FUNNEL:
        evs = [r for r in rows if r["name"] == name]
        if not evs:
            continue
        u = len({r["client_id"] for r in evs})
        print(f"| {name}({label}) | {len(evs)} | {u} | {u * 100 // base}% |")

    # ── 2. 留存(次日/7 日) ──────────────────────────────────────
    print("\n## 留存(按首见日期分组的 client)\n")
    by_client_days = {}
    for r in rows:
        if not r["ts"]:
            continue
        by_client_days.setdefault(r["client_id"], set()).add(r["ts"].date())
    cohorts = {}
    for c, days in by_client_days.items():
        cohorts.setdefault(min(days), []).append((c, days))
    print("| 首见日期 | 新 client | 次日回访 | 7日内回访 |")
    print("|---|---:|---:|---:|")
    for d in sorted(cohorts):
        members = cohorts[d]
        n = len(members)
        d1 = sum(1 for _, days in members if any(0 < (x - d).days <= 1 for x in days))
        d7 = sum(1 for _, days in members if any(0 < (x - d).days <= 7 for x in days))
        print(f"| {d} | {n} | {d1} | {d7} |")

    # ── 3. 活跃(DAU + 事件构成) ─────────────────────────────────
    print("\n## 活跃(按天)\n")
    print("| 日期 | 活跃 client | 事件数 | Top 事件 |")
    print("|---|---:|---:|---|")
    by_day = {}
    for r in rows:
        if r["ts"]:
            by_day.setdefault(r["ts"].date(), []).append(r)
    for d in sorted(by_day):
        evs = by_day[d]
        counts = {}
        for e in evs:
            counts[e["name"]] = counts.get(e["name"], 0) + 1
        top = ", ".join(f"{k}×{v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])[:3])
        print(f"| {d} | {len({e['client_id'] for e in evs})} | {len(evs)} | {top} |")

    # ── 4. 编辑时长(edit_start→edit_end 配对) ────────────────────
    print("\n## 编辑时长(同 client 相邻 start/end 配对,0~6h 有效)\n")
    pairs_ms = []
    by_client_edits = {}
    for r in rows:
        if r["name"] in ("edit_start", "edit_end") and r["ts"]:
            by_client_edits.setdefault(r["client_id"], []).append((r["ts"], r["name"]))
    for c, seq in by_client_edits.items():
        seq.sort()
        start = None
        for ts, name in seq:
            if name == "edit_start":
                start = ts
            elif name == "edit_end" and start:
                ms = (ts - start).total_seconds() * 1000
                if 0 <= ms <= 6 * 3600 * 1000:
                    pairs_ms.append(ms)
                start = None
    if pairs_ms:
        pairs_ms.sort()
        n = len(pairs_ms)
        med = pairs_ms[n // 2] / 1000
        p90 = pairs_ms[int(n * 0.9)] / 1000
        print(f"配对样本 {n} · 中位 {med:.0f}s · P90 {p90:.0f}s · 最长 {pairs_ms[-1] / 1000:.0f}s")
    else:
        print("暂无 edit_start/edit_end 配对数据(v2 客户端覆盖后出现)。")

    # ── 5. 参数分布(快速健康检查) ────────────────────────────────
    print("\n## 参数分布(白名单健康检查)\n")
    pv = {}
    for r in rows:
        for k, v in r["params"].items():
            pv.setdefault((r["name"], k, json.dumps(v, ensure_ascii=False)), 0)
            pv[(r["name"], k, json.dumps(v, ensure_ascii=False))] += 1
    for (name, k, v), n in sorted(pv.items(), key=lambda x: (-x[1], x[0])):
        print(f"- {name}.{k} = {v} ×{n}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    exclude = set()
    if len(argv) >= 3 and argv[1] == "--exclude":
        exclude = set(x for x in argv[2].split(",") if x)
        argv = argv[:1] + argv[3:]
    if len(argv) != 1:
        print(__doc__)
        sys.exit(1)
    main(argv[0], exclude)

#!/usr/bin/env python3
"""v0.5 飞书 OAuth 后端验收脚本 —— 对已部署的后端跑(默认线上阿里云)。

用 /auth/dev-login 旁路造任意飞书身份(需 HG_AUTH_ALLOW_DEV=1),无需真飞书。
覆盖 v0.5 核心保证:硬身份 author 注入、仅作者删除(403/200)、session 校验、
logout 失效、SSE 实时推送。

用法:
    HG_BASE=https://www.deuce.monster/hg uv run python scripts/accept_v05.py
    # 或: HG_BASE=... python3 scripts/accept_v05.py  (需 httpx)
退出码:0=全过,1=有失败。
"""
from __future__ import annotations

import os
import sys
import time

import httpx

BASE = os.environ.get("HG_BASE", "https://www.deuce.monster/hg").rstrip("/")
TIMEOUT = 30

_ok: list[str] = []
_fail: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (_ok if cond else _fail).append(name)
    tag = "PASS" if cond else "FAIL"
    extra = f"  — {detail}" if (detail and not cond) else ""
    print(f"[{tag}] {name}{extra}")


def dev_login(c: httpx.Client, open_id: str, name: str, team: str = "default") -> str:
    r = c.post(f"{BASE}/auth/dev-login", json={"open_id": open_id, "name": name, "team": team})
    assert r.status_code == 200, f"dev-login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def auth(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def main() -> int:
    print(f"=== v0.5 验收,目标 {BASE} ===\n")
    with httpx.Client(timeout=TIMEOUT) as c:
        # 前置:health
        check("health ok", c.get(f"{BASE}/health").json().get("status") == "ok")

        # 造两个不同身份(同团队 default)
        ta = dev_login(c, "ou_alice", "Alice")
        tb = dev_login(c, "ou_bob", "Bob")

        # /auth/me:返回 session 身份
        me = c.get(f"{BASE}/auth/me", headers=auth(ta)).json()
        check("me 返回 open_id+name", me.get("id") == "ou_alice" and me.get("name") == "Alice", str(me))
        check("me 无 token → 401", c.get(f"{BASE}/auth/me").status_code == 401)

        # 建批注:author 必须来自 session,请求体里的 author 被忽略
        created = c.post(
            f"{BASE}/api/annotations",
            headers=auth(ta),
            json={
                "document_id": "doc_accept",
                "selector": {"type": "TextQuoteSelector", "exact": "hello"},
                "quote": "hello",
                "author": {"id": "FORGED", "name": "forged"},  # 应被忽略
            },
        ).json()
        aid = created["id"]
        check(
            "author 来自 session(非 body 伪造)",
            created.get("author") == {"id": "ou_alice", "name": "Alice"},
            str(created.get("author")),
        )
        check("批注带 team_id(default)", created.get("team_id") == "default", str(created.get("team_id")))

        # 非作者删除 → 403(v0.5 硬身份核心)
        r = c.delete(f"{BASE}/api/annotations/{aid}", headers=auth(tb))
        check("非作者删除 → 403", r.status_code == 403, str(r.status_code))

        # 仍存在(未被删)
        lst = c.get(f"{BASE}/api/annotations", params={"document_id": "doc_accept"}, headers=auth(ta)).json()
        check("非作者删失败后批注仍在", any(a["id"] == aid for a in lst.get("items", [])))

        # 作者删除 → 200
        r = c.delete(f"{BASE}/api/annotations/{aid}", headers=auth(ta))
        check("作者删除 → 200", r.status_code == 200, str(r.status_code))

        # 无 session 建批注 → 401
        r = c.post(
            f"{BASE}/api/annotations",
            json={"document_id": "x", "selector": {"type": "TextQuoteSelector", "exact": "x"}, "quote": "x"},
        )
        check("无 session 建批注 → 401", r.status_code == 401, str(r.status_code))

        # logout 后原 token 立即失效
        c.post(f"{BASE}/auth/logout", headers=auth(ta))
        check("logout 后 me → 401", c.get(f"{BASE}/auth/me", headers=auth(ta)).status_code == 401)

        # SSE 实时推送:新身份订阅 doc_sse,Bob 在同 doc 建批注 → 订阅者收到 annotation:created
        # 用 curl -N 读流(httpx/http.client 在小 chunk SSE 上有缓冲问题,curl 稳定)。
        import subprocess

        tl = dev_login(c, "ou_listener", "Listener")  # SSE 订阅专用(未注销)
        proc = subprocess.Popen(
            ["curl", "-sN", "--max-time", "6", f"{BASE}/api/stream?doc=doc_sse&token={tl}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)  # 等 subscribe + hello
        c.post(
            f"{BASE}/api/annotations",
            headers=auth(tb),
            json={
                "document_id": "doc_sse",
                "selector": {"type": "TextQuoteSelector", "exact": "sse"},
                "quote": "sse",
            },
        )
        out, _ = proc.communicate(timeout=8)
        check(
            "SSE 实时推送创建事件",
            b"annotation:created" in (out or b""),
            (out or b"")[:120].decode("utf-8", "replace"),
        )

    print(f"\n=== {len(_ok)} passed, {len(_fail)} failed ===")
    for n in _fail:
        print("  FAILED:", n)
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())

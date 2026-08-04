"""Session 存储 (v0.5 lark-oauth)。

不透明随机 token -> {open_id, name, team_id},带过期。复用 storage 的 SQLite 连接。
"""
from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone

from .storage import _connect, _now

_DEFAULT_TTL = int(os.environ.get("HG_SESSION_TTL", "604800"))  # 7 天
_RENEW_THRESHOLD = 86400  # 滑动续期:剩余不足 1 天则续
# BE-11:session 绝对寿命上限(从创建起算,即便持续活跃也强制重登)。默认 30 天。
_ABSOLUTE_TTL = int(os.environ.get("HG_SESSION_ABSOLUTE_TTL", str(30 * 86400)))


def _expir(ttl: int) -> str:
    ts = datetime.now(timezone.utc).timestamp() + ttl
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def create_session(open_id: str, name: str, team_id: str, ttl: "int | None" = None) -> str:
    token = "sess_" + secrets.token_hex(24)
    c = _connect()
    try:
        c.execute(
            "INSERT INTO sessions(token, open_id, name, team_id, created_at, expires_at) VALUES(?,?,?,?,?,?)",
            (token, open_id, name, team_id, _now(), _expir(ttl if ttl is not None else _DEFAULT_TTL)),
        )
    finally:
        c.close()
    return token


def get_session(token: str) -> "dict[str, str] | None":
    c = _connect()
    try:
        r = c.execute(
            "SELECT open_id, name, team_id, created_at, expires_at FROM sessions WHERE token=?", (token,)
        ).fetchone()
    finally:
        c.close()
    if r is None:
        return None
    now = datetime.now(timezone.utc)
    if now > datetime.fromisoformat(r["expires_at"]):
        return None
    # BE-11:绝对寿命 —— 超过创建后 _ABSOLUTE_TTL 即失效(强制重登),即便滑动续期也不绕过。
    if (now - datetime.fromisoformat(r["created_at"])).total_seconds() > _ABSOLUTE_TTL:
        return None
    return {"open_id": r["open_id"], "name": r["name"], "team_id": r["team_id"]}


def touch_session(token: str) -> "dict[str, str] | None":
    """取 session(同 get_session),并在剩余 < _RENEW_THRESHOLD 时滑动续期。

    过期/不存在返回 None(不续)。鉴权依赖用它,实现"活跃即续期"。
    """
    c = _connect()
    try:
        r = c.execute(
            "SELECT open_id, name, team_id, created_at, expires_at FROM sessions WHERE token=?", (token,)
        ).fetchone()
        if r is None:
            return None
        exp = datetime.fromisoformat(r["expires_at"])
        now = datetime.now(timezone.utc)
        if now > exp:
            return None
        created = datetime.fromisoformat(r["created_at"])
        # BE-11:绝对寿命到 → 失效,不再续。
        if (now - created).total_seconds() > _ABSOLUTE_TTL:
            return None
        if (exp - now).total_seconds() < _RENEW_THRESHOLD:
            # 滑动续期,但 expires_at 不超过创建后 _ABSOLUTE_TTL(绝对寿命硬顶)。
            remaining_abs = _ABSOLUTE_TTL - (now - created).total_seconds()
            c.execute("UPDATE sessions SET expires_at=? WHERE token=?", (_expir(min(_DEFAULT_TTL, max(0, remaining_abs))), token))
        return {"open_id": r["open_id"], "name": r["name"], "team_id": r["team_id"]}
    finally:
        c.close()


def delete_session(token: str) -> bool:
    c = _connect()
    try:
        cur = c.execute("DELETE FROM sessions WHERE token=?", (token,))
        return cur.rowcount > 0
    finally:
        c.close()


def prune_expired() -> int:
    c = _connect()
    try:
        cur = c.execute("DELETE FROM sessions WHERE expires_at < ?", (_now(),))
        return cur.rowcount
    finally:
        c.close()

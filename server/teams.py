"""团队 / 用户 / 邀请存储 (v0.5 档3: Google 身份)。

按 Google sub 记用户与 team 成员关系;邀请码控团队归属。复用 storage 的 SQLite。
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

from .storage import _connect, _now


def upsert_user(sub: str, email: str, name: str, picture: str) -> None:
    """新用户插入;老用户更新 email/name/picture + 刷新 last_seen。"""
    c = _connect()
    try:
        now = _now()
        if c.execute("SELECT 1 FROM users WHERE google_sub=?", (sub,)).fetchone():
            c.execute(
                "UPDATE users SET email=?, name=?, picture=?, last_seen=? WHERE google_sub=?",
                (email, name, picture, now, sub),
            )
        else:
            c.execute(
                "INSERT INTO users(google_sub, email, name, picture, first_seen, last_seen) VALUES(?,?,?,?,?,?)",
                (sub, email, name, picture, now, now),
            )
    finally:
        c.close()


def create_team(name: str, creator_sub: str) -> str:
    """建 team + 创建者自动成成员。返回 team_id。"""
    team_id = "team_" + secrets.token_hex(8)
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute(
                "INSERT INTO teams(team_id, name, created_by_sub, created_at) VALUES(?,?,?,?)",
                (team_id, name or "未命名团队", creator_sub, _now()),
            )
            c.execute(
                "INSERT OR IGNORE INTO memberships(google_sub, team_id, joined_at) VALUES(?,?,?)",
                (creator_sub, team_id, _now()),
            )
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return team_id


def add_membership(sub: str, team_id: str) -> None:
    c = _connect()
    try:
        c.execute(
            "INSERT OR IGNORE INTO memberships(google_sub, team_id, joined_at) VALUES(?,?,?)",
            (sub, team_id, _now()),
        )
    finally:
        c.close()


def user_teams(sub: str) -> "list[dict]":
    """用户的 team 列表(最近加入在前)。"""
    c = _connect()
    try:
        rows = c.execute(
            "SELECT t.team_id, t.name FROM teams t JOIN memberships m ON t.team_id=m.team_id "
            "WHERE m.google_sub=? ORDER BY m.joined_at DESC",
            (sub,),
        ).fetchall()
    finally:
        c.close()
    return [{"team_id": r["team_id"], "name": r["name"]} for r in rows]


def is_member(sub: str, team_id: str) -> bool:
    c = _connect()
    try:
        r = c.execute(
            "SELECT 1 FROM memberships WHERE google_sub=? AND team_id=?", (sub, team_id)
        ).fetchone()
    finally:
        c.close()
    return r is not None


def create_invite(team_id: str, creator_sub: str, max_uses: int = 100) -> str:
    code = "inv_" + secrets.token_hex(6)
    c = _connect()
    try:
        c.execute(
            "INSERT INTO invites(code, team_id, created_by_sub, created_at, max_uses, used_count, expires_at) "
            "VALUES(?,?,?,?,?,?,NULL)",
            (code, team_id, creator_sub, _now(), max_uses, 0),
        )
    finally:
        c.close()
    return code


def redeem_invite(code: str, sub: str) -> "str | None":
    """校验码(存在 + 未超额 + 未过期)→ 加 membership → 自增 used_count。失败返回 None。"""
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            r = c.execute(
                "SELECT team_id, max_uses, used_count, expires_at FROM invites WHERE code=?", (code,)
            ).fetchone()
            if r is None:
                c.execute("ROLLBACK")
                return None
            if r["max_uses"] is not None and r["used_count"] >= r["max_uses"]:
                c.execute("ROLLBACK")
                return None
            if r["expires_at"] and datetime.now(timezone.utc) > datetime.fromisoformat(r["expires_at"]):
                c.execute("ROLLBACK")
                return None
            c.execute(
                "INSERT OR IGNORE INTO memberships(google_sub, team_id, joined_at) VALUES(?,?,?)",
                (sub, r["team_id"], _now()),
            )
            c.execute("UPDATE invites SET used_count=used_count+1 WHERE code=?", (code,))
            c.execute("COMMIT")
            return r["team_id"]
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()

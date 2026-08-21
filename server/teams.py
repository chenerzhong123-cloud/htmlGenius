"""团队 / 用户 / 邀请存储 (v0.5 档3: Google 身份)。

按 Google sub 记用户与 team 成员关系;邀请码控团队归属。复用 storage 的 SQLite。
"""
from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone

from .storage import _connect, _now


def upsert_user(sub: str, email: str, name: str, picture: str) -> str:
    """同步身份资料，并返回当前显示名称。

    身份提供方的名称只在用户尚未自定义时更新，避免下次登录覆盖用户设置。
    """
    c = _connect()
    try:
        now = _now()
        row = c.execute("SELECT name, name_custom FROM users WHERE user_id=?", (sub,)).fetchone()
        if row:
            display_name = row["name"] if row["name_custom"] else name
            c.execute(
                "UPDATE users SET email=?, name=?, picture=?, last_seen=? WHERE user_id=?",
                (email, display_name, picture, now, sub),
            )
        else:
            display_name = name
            c.execute(
                "INSERT INTO users(user_id, email, name, picture, first_seen, last_seen, name_custom) VALUES(?,?,?,?,?,?,0)",
                (sub, email, name, picture, now, now),
            )
    finally:
        c.close()
    return display_name


def update_user_name(user_id: str, name: str) -> str:
    """保存用户主动设置的显示名称；调用方须已完成 session 鉴权。"""
    value = (name or "").strip()
    if not value:
        raise ValueError("name required")
    c = _connect()
    try:
        if c.execute("UPDATE users SET name=?, name_custom=1, last_seen=? WHERE user_id=?",
                     (value, _now(), user_id)).rowcount != 1:
            # 兼容早期 Lark/dev session：它们可能尚未在 users 表中留下资料。
            c.execute(
                "INSERT INTO users(user_id, name, first_seen, last_seen, name_custom) VALUES(?,?,?,?,1)",
                (user_id, value, _now(), _now()),
            )
    finally:
        c.close()
    return value


def create_email_user(email: str, name: str, password_hash: str) -> str:
    """建 email 用户(provider=email, email_verified=1),返回 user_id。已存在则 ValueError。"""
    user_id = "usr_" + secrets.token_hex(12)
    c = _connect()
    try:
        if c.execute(
            "SELECT 1 FROM users WHERE lower(email)=lower(?) AND provider='email'", (email,)
        ).fetchone():
            raise ValueError("email already registered")
        now = _now()
        c.execute(
            "INSERT INTO users(user_id, provider, subject, email, name, picture, "
            "password_hash, email_verified, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (user_id, "email", email, email.strip(), (name or email)[:100],
             "", password_hash, 1, now, now),
        )
    finally:
        c.close()
    return user_id


def get_email_user(email: str) -> "dict | None":
    """登录用:按邮箱+provider=email 查已验证用户。"""
    c = _connect()
    try:
        r = c.execute(
            "SELECT user_id, name, password_hash FROM users "
            "WHERE lower(email)=lower(?) AND provider='email' AND email_verified=1",
            (email.strip(),),
        ).fetchone()
    finally:
        c.close()
    return {"user_id": r["user_id"], "name": r["name"], "password_hash": r["password_hash"]} if r else None


class TeamLimitExceeded(Exception):
    """用户拥有的团队数已达 HG_MAX_TEAMS_PER_USER 上限。"""


def _max_teams_per_user() -> int:
    try:
        return int(os.environ.get("HG_MAX_TEAMS_PER_USER", "10"))
    except (TypeError, ValueError):
        return 10


def create_team(name: str, creator_sub: str) -> str:
    """建 team + 创建者自动成 owner。超 HG_MAX_TEAMS_PER_USER → TeamLimitExceeded。"""
    team_id = "team_" + secrets.token_hex(8)
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            owned = c.execute(
                "SELECT COUNT(*) AS n FROM teams WHERE created_by=?", (creator_sub,)
            ).fetchone()["n"]
            if owned >= _max_teams_per_user():
                raise TeamLimitExceeded(f"team limit reached: {owned}")
            c.execute(
                "INSERT INTO teams(team_id, name, created_by, created_at) VALUES(?,?,?,?)",
                (team_id, name or "未命名团队", creator_sub, _now()),
            )
            c.execute(
                "INSERT OR IGNORE INTO memberships(user_id, team_id, joined_at, role) VALUES(?,?,?,?)",
                (creator_sub, team_id, _now(), "owner"),
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
            "INSERT OR IGNORE INTO memberships(user_id, team_id, joined_at) VALUES(?,?,?)",
            (sub, team_id, _now()),
        )
    finally:
        c.close()


def user_by_email(email: str) -> "dict | None":
    """按 email 查已注册用户(Google 登录时 upsert 写入 email)。未注册 → None。大小写不敏感。"""
    c = _connect()
    try:
        r = c.execute(
            "SELECT user_id, name FROM users WHERE lower(email)=lower(?) LIMIT 1",
            (email.strip(),),
        ).fetchone()
    finally:
        c.close()
    return {"user_id": r["user_id"], "name": r["name"]} if r else None


def user_teams(sub: str) -> "list[dict]":
    """用户的 team 列表(最近加入在前)。"""
    c = _connect()
    try:
        rows = c.execute(
            "SELECT t.team_id, t.name, m.role FROM teams t JOIN memberships m ON t.team_id=m.team_id "
            "WHERE m.user_id=? ORDER BY m.joined_at DESC",
            (sub,),
        ).fetchall()
    finally:
        c.close()
    return [{"team_id": r["team_id"], "name": r["name"], "role": r["role"]} for r in rows]


def is_member(sub: str, team_id: str) -> bool:
    c = _connect()
    try:
        r = c.execute(
            "SELECT 1 FROM memberships WHERE user_id=? AND team_id=?", (sub, team_id)
        ).fetchone()
    finally:
        c.close()
    return r is not None


def create_invite(team_id: str, creator_sub: str, max_uses: int = 50) -> str:
    code = "inv_" + secrets.token_hex(6)
    c = _connect()
    try:
        c.execute(
            "INSERT INTO invites(code, team_id, created_by, created_at, max_uses, used_count, expires_at) "
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
                "INSERT OR IGNORE INTO memberships(user_id, team_id, joined_at) VALUES(?,?,?)",
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


def join_team(code: str, user_id: str) -> "str | None":
    """凭邀请码加入团队(幂等:已是成员直接返回 team_id,不消耗名额)。无效/过期/超额 → None。"""
    c = _connect()
    try:
        row = c.execute(
            "SELECT team_id, max_uses, used_count, expires_at FROM invites WHERE code=?", (code,)
        ).fetchone()
        if row is None:
            return None
        if c.execute(
            "SELECT 1 FROM memberships WHERE user_id=? AND team_id=?", (user_id, row["team_id"])
        ).fetchone():
            return row["team_id"]  # 已是成员 → 幂等返回
        if row["max_uses"] is not None and row["used_count"] >= row["max_uses"]:
            return None
        if row["expires_at"] and datetime.now(timezone.utc) > datetime.fromisoformat(row["expires_at"]):
            return None
        c.execute(
            "INSERT OR IGNORE INTO memberships(user_id, team_id, joined_at) VALUES(?,?,?)",
            (user_id, row["team_id"], _now()),
        )
        c.execute("UPDATE invites SET used_count=used_count+1 WHERE code=?", (code,))
        return row["team_id"]
    finally:
        c.close()


def member_role(sub: str, team_id: str) -> "str | None":
    """'owner' | 'member' | None(非成员)。Lark 团队无 membership 行 → None。"""
    c = _connect()
    try:
        r = c.execute(
            "SELECT role FROM memberships WHERE user_id=? AND team_id=?", (sub, team_id)
        ).fetchone()
    finally:
        c.close()
    return r["role"] if r else None


def rename_team(team_id: str, name: str, actor_sub: str) -> str:
    """owner 修改团队名。权限判断和写入放在同一事务，前端隐藏入口不是权限边界。"""
    value = (name or "").strip()
    if not value:
        raise ValueError("team name required")
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            row = c.execute(
                "SELECT role FROM memberships WHERE user_id=? AND team_id=?", (actor_sub, team_id)
            ).fetchone()
            if row is None or row["role"] != "owner":
                raise PermissionError("only owner can rename team")
            if c.execute("UPDATE teams SET name=? WHERE team_id=?", (value, team_id)).rowcount != 1:
                raise KeyError("team not found")
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return value


def transfer_ownership(team_id: str, target_sub: str, actor_sub: str) -> None:
    """owner 将团队所有权转给现有成员；原 owner 在同一事务内降为 member。"""
    if actor_sub == target_sub:
        raise ValueError("cannot transfer ownership to self")
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            actor = c.execute(
                "SELECT role FROM memberships WHERE user_id=? AND team_id=?", (actor_sub, team_id)
            ).fetchone()
            if actor is None or actor["role"] != "owner":
                raise PermissionError("only owner can transfer ownership")
            target = c.execute(
                "SELECT 1 FROM memberships WHERE user_id=? AND team_id=?", (target_sub, team_id)
            ).fetchone()
            if target is None:
                raise ValueError("target must be a team member")
            c.execute("UPDATE memberships SET role='member' WHERE user_id=? AND team_id=?", (actor_sub, team_id))
            c.execute("UPDATE memberships SET role='owner' WHERE user_id=? AND team_id=?", (target_sub, team_id))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()


def team_members(team_id: str) -> "list[dict]":
    """团队成员(JOIN users 取名;owner 在前)。Lark 团队无 membership 行 → 返空。"""
    c = _connect()
    try:
        rows = c.execute(
            "SELECT m.user_id AS sub, u.name AS name, m.role AS role "
            "FROM memberships m LEFT JOIN users u ON m.user_id=u.user_id "
            "WHERE m.team_id=? ORDER BY m.role DESC, m.joined_at",
            (team_id,),
        ).fetchall()
    finally:
        c.close()
    return [{"sub": r["sub"], "name": r["name"], "role": r["role"]} for r in rows]


def remove_member(team_id: str, target_sub: str, actor_sub: str) -> None:
    """owner 移除成员。actor 非 owner → PermissionError;移除自己 → ValueError(改用解散)。"""
    if actor_sub == target_sub:
        raise ValueError("cannot remove self; dissolve the team instead")
    if member_role(actor_sub, team_id) != "owner":
        raise PermissionError("only owner can remove members")
    c = _connect()
    try:
        c.execute(
            "DELETE FROM memberships WHERE user_id=? AND team_id=?", (target_sub, team_id)
        )
    finally:
        c.close()


def dissolve_team(team_id: str, actor_sub: str) -> None:
    """owner 解散团队:单事务级联删 annotations/versions/documents/invites/memberships/teams。"""
    if member_role(actor_sub, team_id) != "owner":
        raise PermissionError("only owner can dissolve")
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute("DELETE FROM annotations WHERE team_id=?", (team_id,))
            c.execute("DELETE FROM versions WHERE team_id=?", (team_id,))
            c.execute("DELETE FROM documents WHERE team_id=?", (team_id,))
            c.execute("DELETE FROM invites WHERE team_id=?", (team_id,))
            c.execute("DELETE FROM memberships WHERE team_id=?", (team_id,))
            c.execute("DELETE FROM teams WHERE team_id=?", (team_id,))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()

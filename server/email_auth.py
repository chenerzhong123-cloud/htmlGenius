"""邮箱 + 密码注册/登录(带邮箱验证码)。

email_verifications 表暂存待激活注册(只存哈希,绝不存明文码);激活后落 users 表
(provider='email')并复用 sessions.create_session 发令牌。team 归属:邀请码加入 /
建新团队 / 默认个人团队。
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from . import mailer, security, sessions, teams
from .storage import _connect, _now

_CODE_TTL = 600  # 验证码 10 分钟有效
_MAX_ATTEMPTS = 5  # 验证码最多试 5 次
_RESEND_COOLDOWN = 60  # 重发冷却 60 秒


class EmailAuthError(Exception):
    """携带 HTTP status + detail 的业务异常(路由层映射为 HTTPException)。"""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _expire_ts() -> str:
    return datetime.fromtimestamp(time.time() + _CODE_TTL, timezone.utc).isoformat()


def _age(created_at_iso: str) -> float:
    try:
        return time.time() - datetime.fromisoformat(created_at_iso).timestamp()
    except Exception:
        return _RESEND_COOLDOWN  # 解析失败按已过冷却处理(允许重发)


def _validate_email(email: str) -> str:
    email = (email or "").strip()
    if not email or "@" not in email or len(email) > 200:
        raise EmailAuthError(422, "邮箱格式不正确")
    return email


def start_registration(email: str, password: str, name: str | None) -> None:
    """校验 → 查重(已激活 409)→ 重发冷却(429)→ 生成码并哈希存表 → 发邮件。"""
    email = _validate_email(email)
    if len(password) < 8 or len(password) > 256:
        raise EmailAuthError(422, "密码至少 8 位")
    key = email.lower()
    c = _connect()
    try:
        if c.execute(
            "SELECT 1 FROM users WHERE lower(email)=lower(?) AND provider='email' AND email_verified=1",
            (email,),
        ).fetchone():
            raise EmailAuthError(409, "该邮箱已注册")
        row = c.execute("SELECT created_at FROM email_verifications WHERE email=?", (key,)).fetchone()
        if row and _age(row["created_at"]) < _RESEND_COOLDOWN:
            raise EmailAuthError(429, "验证码已发送,请 60 秒后再试")
        code = security.gen_code()
        c.execute(
            "INSERT OR REPLACE INTO email_verifications(email, code_hash, password_hash, name, "
            "created_at, expires_at, attempts) VALUES(?,?,?,?,?,?,0)",
            (key, security.hash_secret(code), security.hash_secret(password), (name or "")[:100],
             _now(), _expire_ts()),
        )
    finally:
        c.close()
    mailer.send_verification_code(email, code)


def _resolve_team(user_id: str, invite_code: str | None, team_name: str | None) -> str:
    if invite_code:
        tid = teams.redeem_invite(invite_code, user_id)
        if tid:
            return tid
        raise EmailAuthError(400, "邀请码无效或已过期")
    if team_name:
        return teams.create_team(team_name, user_id)
    return teams.create_team("我的团队", user_id)


def verify(email: str, code: str, invite_code: str | None = None, team_name: str | None = None) -> dict:
    """校验码(过期/超限/错误分别处理)→ 建用户 → team 归属 → 发 session。"""
    email = _validate_email(email)
    key = email.lower()
    c = _connect()
    try:
        row = c.execute(
            "SELECT code_hash, password_hash, name, expires_at, attempts FROM email_verifications WHERE email=?",
            (key,),
        ).fetchone()
        if row is None:
            raise EmailAuthError(400, "请先获取验证码")
        if datetime.now(timezone.utc) > datetime.fromisoformat(row["expires_at"]):
            c.execute("DELETE FROM email_verifications WHERE email=?", (key,))
            raise EmailAuthError(400, "验证码已过期,请重新获取")
        if row["attempts"] >= _MAX_ATTEMPTS:
            c.execute("DELETE FROM email_verifications WHERE email=?", (key,))
            raise EmailAuthError(400, "尝试次数过多,请重新获取验证码")
        if not security.verify_secret(code, row["code_hash"]):
            c.execute("UPDATE email_verifications SET attempts=attempts+1 WHERE email=?", (key,))
            raise EmailAuthError(400, "验证码错误")
        password_hash = row["password_hash"]
        name = row["name"]
        c.execute("DELETE FROM email_verifications WHERE email=?", (key,))
    finally:
        c.close()
    user_id = teams.create_email_user(email, name, password_hash)
    team_id = _resolve_team(user_id, invite_code, team_name)
    display = name or email
    token = sessions.create_session(user_id, display, team_id)
    return {"token": token, "user": {"id": user_id, "name": display}, "team_id": team_id}


def login(email: str, password: str) -> dict:
    """邮箱+密码 → 校验(不区分"不存在/密码错")→ 取/建团队 → 发 session。"""
    email = _validate_email(email)
    u = teams.get_email_user(email)
    if not u or not u.get("password_hash") or not security.verify_secret(password, u["password_hash"]):
        raise EmailAuthError(401, "邮箱或密码错误")
    teams_list = teams.user_teams(u["user_id"])
    team_id = teams_list[0]["team_id"] if teams_list else teams.create_team("我的团队", u["user_id"])
    token = sessions.create_session(u["user_id"], u["name"], team_id)
    return {"token": token, "user": {"id": u["user_id"], "name": u["name"]}, "team_id": team_id}


def resend(email: str) -> None:
    """重发验证码(保留原 password_hash;同 start_registration 的查重/冷却)。"""
    email = _validate_email(email)
    key = email.lower()
    c = _connect()
    try:
        if c.execute(
            "SELECT 1 FROM users WHERE lower(email)=lower(?) AND provider='email' AND email_verified=1",
            (email,),
        ).fetchone():
            raise EmailAuthError(409, "该邮箱已注册")
        if not c.execute("SELECT 1 FROM email_verifications WHERE email=?", (key,)).fetchone():
            raise EmailAuthError(400, "请先注册")
        row = c.execute("SELECT created_at FROM email_verifications WHERE email=?", (key,)).fetchone()
        if row and _age(row["created_at"]) < _RESEND_COOLDOWN:
            raise EmailAuthError(429, "验证码已发送,请 60 秒后再试")
        code = security.gen_code()
        c.execute(
            "UPDATE email_verifications SET code_hash=?, created_at=?, expires_at=?, attempts=0 WHERE email=?",
            (security.hash_secret(code), _now(), _expire_ts(), key),
        )
    finally:
        c.close()
    mailer.send_verification_code(email, code)

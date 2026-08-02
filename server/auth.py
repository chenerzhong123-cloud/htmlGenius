"""Session 鉴权依赖 (v0.5 lark-oauth)。

- ``require_session``: ``Authorization: Bearer <token>`` -> ``Session``
- ``require_session_query``: ``?token=`` -> ``Session`` (SSE 用,EventSource 不能设头)
- ``issue_state`` / ``consume_state``: OAuth state 防 CSRF,HMAC 自签 + 5min TTL(无状态)

token -> {open_id, name, team_id} 来自 ``sessions`` 表。401 当缺失/无效/过期。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional

from fastapi import Header, HTTPException, Query
from pydantic import BaseModel

from . import sessions
from .envutil import is_dev_env


class Session(BaseModel):
    open_id: str
    name: str
    team_id: str


def _bearer(authorization: Optional[str]) -> str:
    return (authorization or "").removeprefix("Bearer ").strip()


def require_session(authorization: Optional[str] = Header(None)) -> Session:
    """Bearer session token -> Session。缺失/无效/过期 -> 401。"""
    s = sessions.touch_session(_bearer(authorization))
    if s is None:
        raise HTTPException(status_code=401, detail="invalid session")
    return Session(**s)


def require_session_query(token: Optional[str] = Query(None)) -> Session:
    """Query string token -> Session(给 SSE 用)。

    token 用 ``Query(None)`` —— 缺 token 返 401(而非 422),与旧 require_team_query 一致。
    """
    s = sessions.touch_session((token or "").strip()) if token else None
    if s is None:
        raise HTTPException(status_code=401, detail="invalid session")
    return Session(**s)


_STATE_TTL = 300  # 秒


def _state_secret() -> bytes:
    return (os.environ.get("HG_LARK_APP_SECRET") or "dev-insecure-state-secret").encode()


def issue_state() -> str:
    """生成 HMAC 自签 state(base64(body).base64(sig)),含时间戳 + 随机数。"""
    body = json.dumps(
        {"ts": int(time.time()), "n": os.urandom(8).hex()}, separators=(",", ":")
    ).encode()
    sig = hmac.new(_state_secret(), body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body).decode() + "." + base64.urlsafe_b64encode(sig).decode()


def consume_state(state: str) -> bool:
    """校验 state 签名 + 5min 内。任何异常 -> False(不暴露原因)。"""
    try:
        body_b64, sig_b64 = state.split(".")
        body = base64.urlsafe_b64decode(body_b64)
        sig = base64.urlsafe_b64decode(sig_b64)
        if not hmac.compare_digest(sig, hmac.new(_state_secret(), body, hashlib.sha256).digest()):
            return False
        ts = json.loads(body)["ts"]
        return (int(time.time()) - ts) <= _STATE_TTL
    except Exception:
        return False


# === SUP-2: SSE 短时效流票据 ===
# EventSource 不能设自定义头。旧方案把【长期】session token 拼进 ?token= → 落 nginx/代理
# 访问日志即泄漏(且 token 滑动续期、活跃永不过期)。改为:先经鉴权 POST /api/stream/ticket
# 换一张【短时效、仅绑定 team_id】的签名票据,SSE 用 ?ticket= 连接。票据即便进了日志,窗口短
# (默认 60s)且只能开该 team 的只读事件流,不能调任何其它鉴权接口 —— 危害面大幅收窄。
_STREAM_TICKET_TTL = int(os.environ.get("HG_STREAM_TICKET_TTL", "60"))


# 进程级一次性密钥:仅 dev 兜底;进程重启即失效 → 旧票据全失效(明确不安全)。
_DEV_STREAM_SECRET = os.urandom(32)


def _stream_secret() -> bytes:
    """流票据签名密钥。生产无 HG_STREAM_SECRET → fail-closed 抛错(R-3);dev → 一次性内存密钥。"""
    secret = os.environ.get("HG_STREAM_SECRET") or os.environ.get("HG_LARK_APP_SECRET")
    if secret:
        return secret.encode()
    if is_dev_env():
        return _DEV_STREAM_SECRET
    raise RuntimeError("HG_STREAM_SECRET not configured: refusing stream ticket (fail-closed)")


def issue_stream_ticket(team_id: str, ttl: "int | None" = None) -> str:
    """签发绑定 team_id 的短时效签名票据(base64(body).base64(sig)),含过期时间 + 随机数。"""
    body = json.dumps(
        {
            "team_id": team_id,
            "exp": int(time.time()) + (ttl if ttl is not None else _STREAM_TICKET_TTL),
            "n": os.urandom(8).hex(),
        },
        separators=(",", ":"),
    ).encode()
    sig = hmac.new(_stream_secret(), body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body).decode() + "." + base64.urlsafe_b64encode(sig).decode()


def consume_stream_ticket(ticket: str) -> "str | None":
    """校验票据签名 + 未过期 → 返回 team_id;任何异常/过期/篡改 → None(不暴露原因)。"""
    try:
        body_b64, sig_b64 = ticket.split(".")
        body = base64.urlsafe_b64decode(body_b64)
        sig = base64.urlsafe_b64decode(sig_b64)
        if not hmac.compare_digest(sig, hmac.new(_stream_secret(), body, hashlib.sha256).digest()):
            return None
        payload = json.loads(body)
        if int(time.time()) > int(payload["exp"]):
            return None
        team_id = payload.get("team_id")
        return team_id if isinstance(team_id, str) and team_id else None
    except Exception:
        return None

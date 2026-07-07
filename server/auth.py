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

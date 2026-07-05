"""团队 token 鉴权依赖 (v0.4 plugin-collab, Task 2).

提供两个 FastAPI 依赖:
- ``require_team``: 从 ``Authorization: Bearer <token>`` 头读取 token
- ``require_team_query``: 从 query string ``?token=`` 读取 (SSE 端点用)

两者都返回 token 对应的 ``team_id`` (server-injected, 永不来自请求体)。
401 当 token 缺失/无效。

token -> team_id 映射来自环境变量 ``HG_TEAMS`` (JSON 字符串),
``_teams()`` 每次调用都重读,以便测试可以 monkeypatch.setenv。
"""
import json
import os
from typing import Optional

from fastapi import Header, HTTPException, Query


def _teams() -> dict:
    """读取 token -> team_id 映射。每次调用都重读 env,方便测试 monkeypatch。"""
    return json.loads(os.environ.get("HG_TEAMS", "{}"))


def require_team(authorization: Optional[str] = Header(None)) -> str:
    """Bearer token -> team_id。Authorization 头缺失或 token 无效 -> 401。"""
    token = (authorization or "").removeprefix("Bearer ").strip()
    teams = _teams()
    if token not in teams:
        raise HTTPException(status_code=401, detail="invalid token")
    return teams[token]


def require_team_query(token: str = Query(...)) -> str:
    """Query string token -> team_id。给 SSE 端点用 (EventSource 不能设头)。"""
    teams = _teams()
    if token not in teams:
        raise HTTPException(status_code=401, detail="invalid token")
    return teams[token]

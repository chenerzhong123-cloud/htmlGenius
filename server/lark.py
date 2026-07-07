"""飞书 OpenAPI 客户端 (v0.5 lark-oauth)。

v1 流程:authorize -> code -> app_access_token -> access_token(直接回用户信息)。
所有外部 HTTP 走 httpx;失败抛异常,由端点层转 401/502。team_id 优先 tenant_key,
缺失回退 HG_DEFAULT_TEAM。
"""
from __future__ import annotations

import os
import time
import urllib.parse

import httpx

_APP_TOKEN: "dict[str, object]" = {"token": None, "exp": 0.0}


def _base() -> str:
    return os.environ.get("HG_LARK_BASE", "https://open.feishu.cn")


def _app_id() -> str:
    return os.environ.get("HG_LARK_APP_ID", "")


def _app_secret() -> str:
    return os.environ.get("HG_LARK_APP_SECRET", "")


def authorize_url(redirect_uri: str, state: str) -> str:
    q = urllib.parse.urlencode({
        "app_id": _app_id(),
        "redirect_uri": redirect_uri,
        "state": state,
    })
    return f"{_base()}/open-apis/authen/v1/authorize?{q}"


def app_access_token() -> str:
    """带缓存的 app_access_token(默认 2h;提前 60s 续)。"""
    if _APP_TOKEN["token"] and time.time() < float(_APP_TOKEN["exp"]):
        return _APP_TOKEN["token"]  # type: ignore[return-value]
    r = httpx.post(
        f"{_base()}/open-apis/auth/v3/app_access_token/internal",
        json={"app_id": _app_id(), "app_secret": _app_secret()},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"lark app_access_token failed: {data}")
    _APP_TOKEN["token"] = data["app_access_token"]
    _APP_TOKEN["exp"] = time.time() + min(int(data.get("expire", 7200)) - 60, 7200)
    return data["app_access_token"]


def _default_team() -> str:
    return os.environ.get("HG_DEFAULT_TEAM", "default")


def exchange_code(code: str, redirect_uri: str) -> "dict[str, str]":
    """code -> {open_id, name, team_id}。v1 access_token 端点直接回用户信息。"""
    r = httpx.post(
        f"{_base()}/open-apis/authen/v1/access_token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "app_access_token": app_access_token(),
        },
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"lark exchange failed: {data}")
    team_id = data.get("tenant_key") or data.get("tenant_id") or _default_team()
    return {"open_id": data["open_id"], "name": data.get("name", ""), "team_id": team_id}


def reset_cache() -> None:
    """测试钩子:清 app_access_token 缓存。"""
    _APP_TOKEN["token"] = None
    _APP_TOKEN["exp"] = 0.0

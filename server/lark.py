"""飞书 OpenAPI 客户端 (v0.5 lark-oauth, V2)。

V2 流程(标准 OAuth 2.0,RFC 6749;V1 已被飞书标为历史版本,故用 V2):
- authorize: accounts.feishu.cn/open-apis/authen/v1/authorize(用户授权页)→ 回调带 code
- token:     POST open.feishu.cn/open-apis/authen/v2/oauth/token(code → access_token;不含用户信息)
- userinfo:  GET  open.feishu.cn/open-apis/authen/v2/user_info(access_token → open_id/name/tenant_key)

失败抛异常,由端点层转 400/502。team_id 优先 tenant_key,缺失回退 HG_DEFAULT_TEAM。
"""
from __future__ import annotations

import os
import urllib.parse

import httpx


def _base() -> str:
    return os.environ.get("HG_LARK_BASE", "https://open.feishu.cn")


def _accounts_base() -> str:
    # 授权页域名;国际版 Larksuite 需改 accounts.larksuite.com
    return os.environ.get("HG_LARK_ACCOUNTS_BASE", "https://accounts.feishu.cn")


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
    return f"{_accounts_base()}/open-apis/authen/v1/authorize?{q}"


def _default_team() -> str:
    return os.environ.get("HG_DEFAULT_TEAM", "default")


def _user_info(user_access_token: str) -> "dict[str, str]":
    """user_access_token → {open_id, name, team_id}。

    用 /authen/v1/user_info:实测 /authen/v2/user_info 返 404(不存在),飞书文档对
    user_info 的指向也是 v1。V2 token 端点产出的 user_access_token 兼容此端点。
    响应解析兼容 data 包裹与扁平两种。
    """
    r = httpx.get(
        f"{_base()}/open-apis/authen/v1/user_info",
        headers={"Authorization": "Bearer " + user_access_token},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"lark user_info failed: {data}")
    d = data.get("data") or data  # 兼容 data 包裹 / 扁平
    if "open_id" not in d:
        raise RuntimeError(f"lark user_info no open_id: {data}")
    team_id = d.get("tenant_key") or d.get("tenant_id") or _default_team()
    return {"open_id": d["open_id"], "name": d.get("name", ""), "team_id": team_id}


def exchange_code(code: str, redirect_uri: str) -> "dict[str, str]":
    """V2:code → access_token(标准 OAuth2,client_id/secret 在请求体)→ 再取用户信息。

    返回 {open_id, name, team_id}。
    """
    r = httpx.post(
        f"{_base()}/open-apis/authen/v2/oauth/token",
        json={
            "grant_type": "authorization_code",
            "client_id": _app_id(),
            "client_secret": _app_secret(),
            "code": code,
            "redirect_uri": redirect_uri,
        },
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"lark exchange failed: {data}")
    return _user_info(data["access_token"])

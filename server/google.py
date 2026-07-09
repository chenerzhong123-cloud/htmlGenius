"""Google 身份验证 (v0.5 档3)。

access_token → tokeninfo(aud 校验,确保 token 是发给我们这个扩展的,不是别处偷来的)
              + userinfo(sub/email/name/picture)。失败抛异常,端点层转 401。
"""
from __future__ import annotations

import os

import httpx


def _client_id() -> str:
    return os.environ.get("HG_GOOGLE_CLIENT_ID", "")


def verify(access_token: str) -> "dict[str, str]":
    """返回 {sub, email, name, picture}。token 无效/aud 不符 → 抛异常。"""
    # 1) tokeninfo:aud 校验(防 token 来自别的 Google OAuth 应用)+ sub
    ti = httpx.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"access_token": access_token},
        timeout=10,
    )
    ti.raise_for_status()
    d = ti.json()
    if d.get("aud") != _client_id():
        raise RuntimeError(f"token aud mismatch: {d.get('aud')!r} != {_client_id()!r}")
    sub = d.get("sub")
    if not sub:
        raise RuntimeError(f"token no sub: {d}")

    # 2) userinfo:name + picture(email 兜底)
    ui = httpx.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        params={"access_token": access_token},
        timeout=10,
    )
    ui.raise_for_status()
    u = ui.json()
    email = u.get("email") or d.get("email") or ""
    name = u.get("name") or (email.split("@")[0] if email else "用户")
    return {"sub": sub, "email": email, "name": name, "picture": u.get("picture", "")}

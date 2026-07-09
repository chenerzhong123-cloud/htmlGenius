"""Google 身份验证 (档3, Plan A: JWT 离线验证)。

后端**不调 Google**(阿里云国内被墙,连不通 oauth2.googleapis.com)。改用缓存的
Google JWKS 公钥(从能连 Google 的机器抓 https://www.googleapis.com/oauth2/v3/certs
推到本地文件),本地验证 ID token 的 RS256 签名 + aud/iss/exp。

JWKS 文件路径由 env HG_GOOGLE_JWKS_FILE 指定;文件 mtime 变了自动重载(免重启)。
"""
from __future__ import annotations

import json
import os

import jwt

_JWKS_CACHE: dict = {"mtime": -1, "keys": {}}  # kid -> RSA public key


def _client_id() -> str:
    return os.environ.get("HG_GOOGLE_CLIENT_ID", "")


def _jwks_file() -> str:
    return os.environ.get("HG_GOOGLE_JWKS_FILE", "")


def _load_keys() -> "dict[str, object]":
    """读 JWKS 文件 → {kid: public_key}。mtime 变了才重新解析(免重启刷新)。"""
    path = _jwks_file()
    if not path or not os.path.exists(path):
        raise RuntimeError(
            f"Google JWKS 文件不存在: {path!r}"
            f"(从能连 Google 的机器抓 https://www.googleapis.com/oauth2/v3/certs,推到该路径)"
        )
    mtime = os.path.getmtime(path)
    if _JWKS_CACHE["mtime"] == mtime:
        return _JWKS_CACHE["keys"]
    with open(path, encoding="utf-8") as f:
        jwks = json.load(f)
    keys = {}
    for jwk in jwks.get("keys", []):
        kid = jwk.get("kid")
        if kid:
            keys[kid] = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
    _JWKS_CACHE["mtime"] = mtime
    _JWKS_CACHE["keys"] = keys
    return keys


def verify(id_token: str) -> "dict[str, str]":
    """验证 Google ID token(RS256 JWT),返回 {sub, email, name, picture}。

    失败(签名错/aud 不符/iss 不符/过期/JWKS 无匹配 key)→ 抛异常,端点层转 401。
    """
    keys = _load_keys()
    header = jwt.get_unverified_header(id_token)
    kid = header.get("kid")
    key = keys.get(kid)
    if key is None:
        raise RuntimeError(f"JWKS 无匹配 key(kid={kid!r});JWKS 可能过期,需刷新")
    payload = jwt.decode(
        id_token,
        key=key,
        algorithms=["RS256"],
        audience=_client_id(),            # 校验 aud == 我们的 client_id
        issuer="https://accounts.google.com",  # 校验 iss
        # exp 由 PyJWT 自动校验
    )
    sub = payload.get("sub")
    if not sub:
        raise RuntimeError(f"token no sub: {payload}")
    email = payload.get("email", "")
    name = payload.get("name") or (email.split("@")[0] if email else "用户")
    return {"sub": sub, "email": email, "name": name, "picture": payload.get("picture", "")}

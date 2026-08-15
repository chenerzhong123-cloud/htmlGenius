"""密码 / 验证码哈希(stdlib pbkdf2-hmac-sha256,零依赖)。

格式:``pbkdf2$<iterations>$<salt_hex>$<hash_hex>``。verify 用 ``hmac.compare_digest``
常量时间比较,防时序侧信道。
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

_ITER = 200_000
_DKLEN = 32


def hash_secret(secret: str) -> str:
    """对密码/验证码加盐哈希。每次随机盐 → 同输入不同输出。"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, _ITER, _DKLEN)
    return f"pbkdf2${_ITER}${salt.hex()}${dk.hex()}"


def verify_secret(secret: str, stored: str) -> bool:
    """常量时间校验。stored 格式异常/不匹配 → False(不抛错、不暴露原因)。"""
    try:
        algo, iter_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", secret.encode("utf-8"), bytes.fromhex(salt_hex), int(iter_s), _DKLEN
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def gen_code() -> str:
    """6 位数字验证码(首位可为 0)。"""
    return f"{secrets.randbelow(1_000_000):06d}"

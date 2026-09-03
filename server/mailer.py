"""验证码邮件(env 驱动;开发环境未配 ``HG_SMTP_HOST`` 时使用日志模式)。

- 日志模式:验证码打到 stdout,仅供开发/测试使用;生产环境会安全失败。
- SMTP 模式:``smtplib`` SSL(465)发信。生产推荐阿里云邮件推送(smtpdm.aliyun.com,
  需给发信域名配 SPF/DKIM + 建发信地址)。
"""
from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage


def _cfg() -> dict:
    return {
        "host": os.environ.get("HG_SMTP_HOST"),
        "port": int(os.environ.get("HG_SMTP_PORT", "465")),
        "user": os.environ.get("HG_SMTP_USER"),
        "pass": os.environ.get("HG_SMTP_PASS"),
        "from": os.environ.get("HG_SMTP_FROM") or os.environ.get("HG_SMTP_USER"),
    }


def send_verification_code(to_email: str, code: str) -> None:
    cfg = _cfg()
    if not cfg["host"]:
        if os.environ.get("HG_ENV", "").strip().lower() in {"prod", "production"}:
            raise RuntimeError("HG_SMTP_HOST is required in production")
        # 日志模式:开发/测试用,不真实发信
        print(f"[email-code] to={to_email} code={code}", flush=True)
        return
    msg = EmailMessage()
    msg["From"] = cfg["from"]
    msg["To"] = to_email
    msg["Subject"] = "Your PageTack verification code"
    msg.set_content(
        f"Your PageTack verification code is: {code}\n\n"
        "This code expires in 10 minutes. If you did not request it, you can ignore this email."
    )
    with smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15) as s:
        if cfg["user"]:
            s.login(cfg["user"], cfg["pass"] or "")
        s.send_message(msg)

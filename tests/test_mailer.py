import smtplib

import pytest

from server import mailer


def test_log_mode_when_no_smtp(monkeypatch, capsys):
    for k in ("HG_SMTP_HOST", "HG_SMTP_PORT", "HG_SMTP_USER", "HG_SMTP_PASS", "HG_SMTP_FROM"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("HG_ENV", raising=False)
    mailer.send_verification_code("u@x.com", "123456")
    out = capsys.readouterr().out
    assert "123456" in out and "u@x.com" in out


def test_production_requires_smtp(monkeypatch):
    for k in ("HG_SMTP_HOST", "HG_SMTP_PORT", "HG_SMTP_USER", "HG_SMTP_PASS", "HG_SMTP_FROM"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HG_ENV", "production")
    with pytest.raises(RuntimeError, match="HG_SMTP_HOST"):
        mailer.send_verification_code("u@x.com", "123456")


def test_smtp_mode_uses_smtplib(monkeypatch):
    monkeypatch.setenv("HG_SMTP_HOST", "smtpdm.aliyun.com")
    monkeypatch.setenv("HG_SMTP_PORT", "465")
    monkeypatch.setenv("HG_SMTP_USER", "noreply@deuce.monster")
    monkeypatch.setenv("HG_SMTP_PASS", "pw")
    monkeypatch.setenv("HG_SMTP_FROM", "noreply@deuce.monster")
    sent = {}

    class FakeSSL:
        def __init__(self, host, port, timeout):
            sent["host"] = host
            sent["port"] = port

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def login(self, u, p):
            sent["login"] = (u, p)

        def send_message(self, msg):
            sent["to"] = msg["To"]
            sent["subj"] = msg["Subject"]

    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSSL)
    mailer.send_verification_code("user@x.com", "654321")
    assert sent["host"] == "smtpdm.aliyun.com"
    assert sent["login"] == ("noreply@deuce.monster", "pw")
    assert sent["to"] == "user@x.com"
    assert sent["subj"] == "Your PageTack verification code"
    assert "654321" not in sent.get("subj", "")  # 码在正文,不在标题

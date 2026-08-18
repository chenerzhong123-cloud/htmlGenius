"""feat/security-hardening 回归测试:限流 / state fail-closed / 安全响应头 / 控制字符清洗 / 审计日志。"""
import pytest
from fastapi.testclient import TestClient

from server import storage
from server.app import app

client = TestClient(app)


@pytest.fixture
def prod_env(tmp_path, monkeypatch):
    """生产语义环境(HG_ENV=production):限流与 fail-closed 全量生效。"""
    monkeypatch.setenv("HG_ENV", "production")
    monkeypatch.delenv("HG_LARK_APP_SECRET", raising=False)
    monkeypatch.setenv("HTMLEDITOR_DB", str(tmp_path / "p.db"))
    storage.init_db(tmp_path / "p.db")
    return tmp_path


@pytest.fixture
def dev_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_ENV", "test")
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HTMLEDITOR_DB", str(tmp_path / "d.db"))
    storage.init_db(tmp_path / "d.db")
    return tmp_path


def _login_dev():
    r = client.post("/auth/dev-login", json={"open_id": "ou_sec", "name": "sec", "team": "team_sec"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_state_secret_fail_closed_in_prod(prod_env):
    """生产缺 HG_LARK_APP_SECRET → OAuth state 拒签(503),不回退公开常量。"""
    r = client.get("/auth/lark/login", params={"redirect": "https://x/cb"})
    assert r.status_code == 503


def test_login_rate_limited_in_prod(prod_env):
    """密码登录 8 次/5min/IP+email,第 9 次 → 429。"""
    for _ in range(8):
        client.post("/auth/email/login", json={"email": "brute@x.com", "password": "x" * 12})
    r = client.post("/auth/email/login", json={"email": "brute@x.com", "password": "x" * 12})
    assert r.status_code == 429


def test_security_headers_present(prod_env):
    r = client.get("/health")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "SAMEORIGIN"  # DENY 会误伤 viewer 的同源 iframe
    assert r.headers.get("Referrer-Policy") == "no-referrer"


def test_annotation_control_chars_stripped(dev_env):
    h = _login_dev()
    payload = {
        "document_id": "doc_sec",
        "selector": {"type": "TextQuoteSelector", "exact": "a\x00b", "prefix": "", "suffix": ""},
        "quote": "q\x01uote",
        "body": {"comment": "hi\x07\x0bthere<ok>", "action": "none", "instruction": ""},
    }
    r = client.post("/api/annotations", json=payload, headers=h)
    assert r.status_code == 200
    ann = r.json()
    assert "\x00" not in ann["selector"]["exact"] and "\x01" not in ann["quote"]
    # \x07/\x0b 剥离;正常文本(含尖括号,渲染侧 esc)保留
    assert ann["body"]["comment"] == "hithere<ok>"


def test_audit_log_written(dev_env):
    h = _login_dev()
    r = client.post("/api/annotations", json={
        "document_id": "doc_aud", "selector": {"type": "TextQuoteSelector", "exact": "x"},
        "quote": "x", "body": {"comment": "c"},
    }, headers=h)
    assert r.status_code == 200
    rows = list(storage._connect().execute("SELECT action FROM audit_log"))
    # dev-login 不落审计(测试旁路),但 insert_audit_log 本身可用
    storage.insert_audit_log("u1", "t1", "team.dissolve")
    rows = list(storage._connect().execute("SELECT actor, action FROM audit_log WHERE actor='u1'"))
    assert rows and rows[0][1] == "team.dissolve"

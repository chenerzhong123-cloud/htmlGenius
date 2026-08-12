import pytest
from fastapi.testclient import TestClient

from server import storage, teams
from server.app import app

client = TestClient(app)


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_ENV", "test")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "s")
    monkeypatch.setenv("HG_DEFAULT_TEAM", "team_d")
    storage.init_db(tmp_path / "e.db")


@pytest.fixture
def capture_code(monkeypatch):
    """拦截 mailer,捕获发出的验证码(生产绝不存明文,仅测试用)。"""
    box = {}
    monkeypatch.setattr("server.mailer.send_verification_code",
                        lambda to, code: box.__setitem__("code", code))
    return box


def _reg(email="a@x.com", pw="pw123456", name="Alice"):
    return client.post("/auth/email/register", json={"email": email, "password": pw, "name": name})


def test_register_then_verify_then_login(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    assert _reg().status_code == 200
    v = client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    assert v.status_code == 200
    tok = v.json()["token"]
    assert v.json()["user"]["name"] == "Alice"
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.status_code == 200
    lg = client.post("/auth/email/login", json={"email": "a@x.com", "password": "pw123456"})
    assert lg.status_code == 200 and lg.json()["token"]
    bad = client.post("/auth/email/login", json={"email": "a@x.com", "password": "wrong"})
    assert bad.status_code == 401


def test_verify_wrong_code_rejected(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg()
    wrong = "000000" if capture_code["code"] != "000000" else "111111"
    assert client.post("/auth/email/verify", json={"email": "a@x.com", "code": wrong}).status_code == 400
    # 正确码仍可用(attempts < 5)
    v = client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    assert v.status_code == 200


def test_verify_bad_code_format(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    _reg()
    assert client.post("/auth/email/verify", json={"email": "a@x.com", "code": "abcd"}).status_code == 422


def test_duplicate_verified_register(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg()
    client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    assert _reg().status_code == 409


def test_password_too_short(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.post("/auth/email/register", json={"email": "a@x.com", "password": "123", "name": "A"})
    assert r.status_code == 422


def test_verify_with_invite_code_joins_team(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    tid = teams.create_team("Shared", "goog_owner")
    code = teams.create_invite(tid, "goog_owner")
    _reg(email="b@x.com")
    v = client.post("/auth/email/verify",
                    json={"email": "b@x.com", "code": capture_code["code"], "invite_code": code})
    assert v.status_code == 200 and v.json()["team_id"] == tid
    assert teams.is_member(v.json()["user"]["id"], tid)


def test_verify_creates_default_team(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg()
    v = client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    assert v.status_code == 200 and v.json()["team_id"]

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


def test_probe_existing_vs_new(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg()  # a@x.com 待激活(未验证)
    # 未验证 → 不算已存在(仍可重新注册)
    assert client.post("/auth/email/probe", json={"email": "a@x.com"}).json()["exists"] is False
    # 激活后 → 已存在
    client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    assert client.post("/auth/email/probe", json={"email": "a@x.com"}).json()["exists"] is True
    # 全新邮箱 → 不存在
    assert client.post("/auth/email/probe", json={"email": "new@x.com"}).json()["exists"] is False


def test_email_session_create_and_join_workspace(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg(email="a@x.com")
    v = client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]}).json()
    assert "teams" in v and len(v["teams"]) >= 1  # verify 响应带 teams
    H = {"Authorization": "Bearer " + v["token"]}
    # 创建新工作区(Google/email 通用)
    r = client.post("/auth/teams", json={"name": "新项目"}, headers=H)
    assert r.status_code == 201 and r.json()["team_name"] == "新项目"
    assert len(r.json()["teams"]) >= 2
    new_tok = r.json()["token"]
    # 在新工作区生成邀请码 → 另一 email 用户加入
    invite = client.post("/auth/invites", headers={"Authorization": "Bearer " + new_tok}).json()["code"]
    _reg(email="b@x.com")
    vb = client.post("/auth/email/verify", json={"email": "b@x.com", "code": capture_code["code"]}).json()
    bH = {"Authorization": "Bearer " + vb["token"]}
    j = client.post("/auth/teams/join", json={"invite_code": invite}, headers=bH)
    assert j.status_code == 200 and j.json()["team_id"] == r.json()["team_id"]
    assert "teams" in j.json()
    # 幂等:重复 join 同一码仍 200
    assert client.post("/auth/teams/join", json={"invite_code": invite}, headers=bH).status_code == 200
    # 无效码 → 400
    assert client.post("/auth/teams/join", json={"invite_code": "inv_nope"}, headers=bH).status_code == 400


def test_email_login_returns_teams(tmp_path, monkeypatch, capture_code):
    _init(tmp_path, monkeypatch)
    _reg(email="a@x.com")
    client.post("/auth/email/verify", json={"email": "a@x.com", "code": capture_code["code"]})
    lg = client.post("/auth/email/login", json={"email": "a@x.com", "password": "pw123456"}).json()
    assert "teams" in lg and len(lg["teams"]) >= 1

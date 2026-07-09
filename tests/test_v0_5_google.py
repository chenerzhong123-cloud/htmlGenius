import time

import pytest
from fastapi.testclient import TestClient

from server import google, storage, teams
from server.app import app

client = TestClient(app)


class _FR:
    def __init__(self, p):
        self._p = p
        self.status_code = 200

    def json(self):
        return self._p

    def raise_for_status(self):
        pass


def _patch_http(monkeypatch, tokeninfo, userinfo):
    def fake_get(url, params=None, **kw):
        return _FR(tokeninfo if "tokeninfo" in url else userinfo)
    monkeypatch.setattr("server.google.httpx.get", fake_get)


# === google.verify ===


def test_verify_ok(monkeypatch):
    monkeypatch.setenv("HG_GOOGLE_CLIENT_ID", "cid_xxx")
    _patch_http(monkeypatch, {"aud": "cid_xxx", "sub": "g_1", "email": "a@b.com"},
                {"sub": "g_1", "name": "Alice", "email": "a@b.com", "picture": "p"})
    info = google.verify("tok")
    assert info == {"sub": "g_1", "email": "a@b.com", "name": "Alice", "picture": "p"}


def test_verify_aud_mismatch_rejected(monkeypatch):
    monkeypatch.setenv("HG_GOOGLE_CLIENT_ID", "cid_xxx")
    _patch_http(monkeypatch, {"aud": "OTHER_APP", "sub": "g_1"}, {})
    with pytest.raises(RuntimeError):
        google.verify("tok")  # 别处偷来的 token(aud 不符)被拒


def test_verify_name_fallback(monkeypatch):
    monkeypatch.setenv("HG_GOOGLE_CLIENT_ID", "cid_xxx")
    _patch_http(monkeypatch, {"aud": "cid_xxx", "sub": "g_1"},
                {"sub": "g_1", "email": "bob@x.com"})  # 无 name
    info = google.verify("tok")
    assert info["name"] == "bob"  # 用 email 本地部分兜底


# === 端点流程 ===


def _init(tmp_path):
    storage.init_db(tmp_path / "g.db")


def _mock_google(sub, name, email="a@b.com", monkeypatch=None):
    if monkeypatch:
        monkeypatch.setattr(
            "server.google.verify",
            lambda at: {"sub": sub, "email": email, "name": name, "picture": ""},
        )


def test_google_create_team_and_session(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock_google("g_1", "Alice", monkeypatch=monkeypatch)
    r = client.post("/auth/google", json={"access_token": "t", "action": "create", "team_name": "MyTeam"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["name"] == "Alice" and len(j["teams"]) == 1 and j["teams"][0]["name"] == "MyTeam"
    tid = j["teams"][0]["team_id"]

    s = client.post("/auth/google/session", json={"access_token": "t", "team_id": tid})
    assert s.status_code == 200
    assert s.json()["token"].startswith("sess_")
    assert s.json()["user"] == {"id": "g_1", "name": "Alice"}


def test_google_session_not_member_403(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock_google("g_outsider", "X", monkeypatch=monkeypatch)
    # 先让 g_1 建一个 team
    _mock_google("g_1", "Alice", monkeypatch=monkeypatch)
    j = client.post("/auth/google", json={"access_token": "t", "action": "create"}).json()
    tid = j["teams"][0]["team_id"]
    # 局外人拿不到 session
    _mock_google("g_outsider", "X", monkeypatch=monkeypatch)
    r = client.post("/auth/google/session", json={"access_token": "t", "team_id": tid})
    assert r.status_code == 403


def test_invite_and_join(tmp_path, monkeypatch):
    _init(tmp_path)
    # Alice 建 team
    _mock_google("g_1", "Alice", monkeypatch=monkeypatch)
    j = client.post("/auth/google", json={"access_token": "t", "action": "create", "team_name": "T"}).json()
    tid = j["teams"][0]["team_id"]
    # Alice 拿 session → 生邀请码
    s = client.post("/auth/google/session", json={"access_token": "t", "team_id": tid}).json()
    inv = client.post("/auth/invites", headers={"Authorization": f"Bearer {s['token']}"}).json()
    assert inv["code"].startswith("inv_") and inv["team_id"] == tid
    # Bob 用码加入 → 出现在 Bob 的 team 列表
    _mock_google("g_2", "Bob", email="b@b.com", monkeypatch=monkeypatch)
    j2 = client.post("/auth/google", json={"access_token": "t2", "action": "join", "code": inv["code"]}).json()
    assert j2["name"] == "Bob"
    assert any(t["team_id"] == tid for t in j2["teams"])


def test_join_bad_code(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock_google("g_1", "Alice", monkeypatch=monkeypatch)
    r = client.post("/auth/google", json={"access_token": "t", "action": "join", "code": "inv_nope"})
    assert r.status_code == 400


def test_redeem_code_overuse(tmp_path, monkeypatch):
    _init(tmp_path)
    # 直接造一个 max_uses=1 的码
    tid = teams.create_team("T", "g_1")
    code = teams.create_invite(tid, "g_1", max_uses=1)
    assert teams.redeem_invite(code, "g_a") == tid  # 第 1 次
    assert teams.redeem_invite(code, "g_b") is None  # 第 2 次超额失败

from fastapi.testclient import TestClient

from server import sessions, storage
from server.app import app
from server.models import DocumentCreate

client = TestClient(app)


def _init(tmp_path, monkeypatch, dev="1"):
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", dev)
    monkeypatch.setenv("HG_LARK_APP_ID", "cli_x")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_x")
    monkeypatch.setenv("HG_DEFAULT_TEAM", "team_d")
    storage.init_db(tmp_path / "e.db")


def test_lark_login_returns_authurl(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.get("/auth/lark/login", params={"redirect": "https://ext.chromiumapp.org/"})
    assert r.status_code == 200
    j = r.json()
    assert j["auth_url"].startswith("https://open.feishu.cn/open-apis/authen/v1/authorize?")
    assert "state" in j and j["state"]


def test_dev_login_and_me_and_logout(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.post("/auth/dev-login", json={"open_id": "ou_1", "name": "alice", "team": "team_a"})
    assert r.status_code == 200
    assert r.json()["user"] == {"id": "ou_1", "name": "alice"}
    assert r.json()["team_id"] == "team_a"
    tok = r.json()["token"]
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.status_code == 200 and me.json()["id"] == "ou_1"
    out = client.post("/auth/logout", headers={"Authorization": f"Bearer {tok}"})
    assert out.status_code == 200
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_dev_login_disabled_in_prod(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch, dev="0")
    r = client.post("/auth/dev-login", json={"open_id": "ou_1", "name": "alice"})
    assert r.status_code == 404


def test_callback(monkeypatch, tmp_path):
    _init(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "server.lark.exchange_code",
        lambda code, redir: {"open_id": "ou_9", "name": "飞书", "team_id": "tk_1"},
    )
    st = client.get(
        "/auth/lark/login", params={"redirect": "https://ext.chromiumapp.org/"}
    ).json()["state"]
    r = client.post(
        "/auth/lark/callback",
        json={"code": "c", "redirect_uri": "https://ext.chromiumapp.org/", "state": st},
    )
    assert r.status_code == 200
    j = r.json()
    assert j["user"] == {"id": "ou_9", "name": "飞书"} and j["team_id"] == "tk_1"
    assert j["token"].startswith("sess_")


def test_callback_bad_state(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.post(
        "/auth/lark/callback",
        json={"code": "c", "redirect_uri": "https://ext.chromiumapp.org/", "state": "garbage"},
    )
    assert r.status_code == 400


def test_me_requires_session(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    assert client.get("/auth/me").status_code == 401


def test_annotation_uses_session_identity(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    storage.register_document(DocumentCreate(document_id="doc_x"))
    tok = sessions.create_session("ou_a", "alice", "team_a")
    H = {"Authorization": f"Bearer {tok}"}
    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_x",
            "selector": {"type": "TextQuoteSelector", "exact": "hi"},
            "quote": "hi",
            "author": {"id": "forged", "name": "x"},  # 应被 session 覆盖
        },
        headers=H,
    )
    assert r.status_code == 200
    assert r.json()["author"] == {"id": "ou_a", "name": "alice"}
    assert r.json()["team_id"] == "team_a"


def test_delete_non_owner_403(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    storage.register_document(DocumentCreate(document_id="doc_x"))
    a = sessions.create_session("ou_a", "alice", "team_a")
    b = sessions.create_session("ou_b", "bob", "team_a")
    created = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_x",
            "selector": {"type": "TextQuoteSelector", "exact": "hi"},
            "quote": "hi",
        },
        headers={"Authorization": f"Bearer {a}"},
    ).json()
    d = client.delete(f"/api/annotations/{created['id']}", headers={"Authorization": f"Bearer {b}"})
    assert d.status_code == 403

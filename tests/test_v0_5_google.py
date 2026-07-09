import base64
import json
import time

import pytest
import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from server import google, storage, teams
from server.app import app

client = TestClient(app)
CID = "cid_xxx"


def _b64u(x):
    return base64.urlsafe_b64encode(x.to_bytes((x.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()


@pytest.fixture
def jwks_env(tmp_path, monkeypatch):
    """生成 RSA key + JWKS 文件,指到 google.verify。返回私钥 PEM(用于签测试 JWT)。"""
    monkeypatch.setenv("HG_GOOGLE_CLIENT_ID", CID)
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nums = priv.public_key().public_numbers()
    jwk = {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "testkid",
           "n": _b64u(nums.n), "e": _b64u(nums.e)}
    jwks_path = tmp_path / "jwks.json"
    jwks_path.write_text(json.dumps({"keys": [jwk]}))
    monkeypatch.setenv("HG_GOOGLE_JWKS_FILE", str(jwks_path))
    priv_pem = priv.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    google._JWKS_CACHE["mtime"] = -1  # 强制重载
    return priv_pem


def _sign(priv_pem, kid="testkid", **overrides):
    payload = {"sub": "g_1", "email": "a@b.com", "name": "Alice", "picture": "p",
               "iss": "https://accounts.google.com", "aud": CID, "exp": int(time.time()) + 100}
    payload.update(overrides)
    return pyjwt.encode(payload, priv_pem, algorithm="RS256", headers={"kid": kid})


# === google.verify(真实 JWT 验签,Plan A)==


def test_verify_ok(jwks_env):
    info = google.verify(_sign(jwks_env))
    assert info == {"sub": "g_1", "email": "a@b.com", "name": "Alice", "picture": "p"}


def test_verify_bad_aud_rejected(jwks_env):
    with pytest.raises(Exception):
        google.verify(_sign(jwks_env, aud="OTHER_APP"))  # aud 不符


def test_verify_expired_rejected(jwks_env):
    with pytest.raises(Exception):
        google.verify(_sign(jwks_env, exp=int(time.time()) - 10))


def test_verify_unknown_kid_rejected(jwks_env):
    with pytest.raises(RuntimeError, match="JWKS"):
        google.verify(_sign(jwks_env, kid="unknown"))  # JWKS 无匹配 key


def test_verify_name_fallback(jwks_env):
    t = _sign(jwks_env)
    # 改 payload 去掉 name,重签
    import jwt as _j
    payload = _j.decode(t, options={"verify_signature": False})
    payload["name"] = None
    t2 = pyjwt.encode(payload, jwks_env, algorithm="RS256", headers={"kid": "testkid"})
    assert google.verify(t2)["name"] == "a"  # email 本地部分兜底


# === 端点流程(mock google.verify)==


def _init(tmp_path):
    storage.init_db(tmp_path / "g.db")


def _mock(sub, name, monkeypatch):
    monkeypatch.setattr("server.google.verify", lambda it: {"sub": sub, "email": sub + "@x.com", "name": name, "picture": ""})


def test_google_create_team_and_session(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock("g_1", "Alice", monkeypatch)
    r = client.post("/auth/google", json={"id_token": "t", "action": "create", "team_name": "MyTeam"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["name"] == "Alice" and len(j["teams"]) == 1 and j["teams"][0]["name"] == "MyTeam"
    tid = j["teams"][0]["team_id"]
    s = client.post("/auth/google/session", json={"id_token": "t", "team_id": tid})
    assert s.status_code == 200 and s.json()["token"].startswith("sess_")


def test_google_session_not_member_403(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock("g_1", "Alice", monkeypatch)
    j = client.post("/auth/google", json={"id_token": "t", "action": "create"}).json()
    tid = j["teams"][0]["team_id"]
    _mock("g_outsider", "X", monkeypatch)
    assert client.post("/auth/google/session", json={"id_token": "t", "team_id": tid}).status_code == 403


def test_invite_and_join(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock("g_1", "Alice", monkeypatch)
    j = client.post("/auth/google", json={"id_token": "t", "action": "create", "team_name": "T"}).json()
    tid = j["teams"][0]["team_id"]
    s = client.post("/auth/google/session", json={"id_token": "t", "team_id": tid}).json()
    inv = client.post("/auth/invites", headers={"Authorization": f"Bearer {s['token']}"}).json()
    assert inv["code"].startswith("inv_") and inv["team_id"] == tid
    _mock("g_2", "Bob", monkeypatch)
    j2 = client.post("/auth/google", json={"id_token": "t2", "action": "join", "code": inv["code"]}).json()
    assert j2["name"] == "Bob"
    assert any(t["team_id"] == tid for t in j2["teams"])


def test_join_bad_code(tmp_path, monkeypatch):
    _init(tmp_path)
    _mock("g_1", "Alice", monkeypatch)
    assert client.post("/auth/google", json={"id_token": "t", "action": "join", "code": "inv_nope"}).status_code == 400


def test_redeem_code_overuse(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("T", "g_1")
    code = teams.create_invite(tid, "g_1", max_uses=1)
    assert teams.redeem_invite(code, "g_a") == tid
    assert teams.redeem_invite(code, "g_b") is None

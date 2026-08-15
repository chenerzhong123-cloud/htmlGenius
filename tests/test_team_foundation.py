"""团队地基 (scope A) 测试。

R-1：文档/版本按 team_id 强制隔离（storage 层 + HTTP 层）。
后续任务追加：R-3 fail-closed / owner 治理 / e2e。
"""
import pytest
from fastapi.testclient import TestClient

from server import auth, sessions, storage, teams
from server.app import app
from server.models import DocumentCreate, VersionCreate

client = TestClient(app)


def _init(tmp_path):
    storage.init_db(tmp_path / "tf.db")


def _dev_login(team, open_id=None, name=None):
    """dev-login 旁路直接造指定 team 的 session（需 HG_AUTH_ALLOW_DEV + HG_ENV=test）。"""
    r = client.post(
        "/auth/dev-login",
        json={"open_id": open_id or team, "name": name or team, "team": team},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


# === R-1：storage 层文档/版本按 team 隔离 ===


def test_storage_team_document_isolation(tmp_path):
    """team_a、team_b 同名 doc 互不可见；版本号各自独立。"""
    _init(tmp_path)
    storage.register_document("team_a", DocumentCreate(document_id="d", title="A"))
    storage.register_document("team_b", DocumentCreate(document_id="d", title="B"))
    assert storage.get_document("team_a", "d")["title"] == "A"
    assert storage.get_document("team_b", "d")["title"] == "B"
    storage.add_version("team_a", "d", VersionCreate(html_content="<a/>", source="ai-gen"))
    assert storage.get_document("team_a", "d")["current_version"] == 1
    assert storage.get_document("team_b", "d")["current_version"] == 0  # 不受影响


def test_storage_other_team_doc_invisible(tmp_path):
    """team_b 查 team_a 的 doc → get_document None / 版本 html None / 版本列表空。"""
    _init(tmp_path)
    storage.register_document("team_a", DocumentCreate(document_id="d"))
    storage.add_version("team_a", "d", VersionCreate(html_content="<x/>", source="ai-gen"))
    assert storage.get_document("team_b", "d") is None
    assert storage.get_version_html("team_b", "d", 1) is None
    assert storage.list_versions("team_b", "d") == []


# === R-1：HTTP 层（app.py 传 session.team_id） ===


def test_http_team_document_isolation(tmp_path, monkeypatch):
    """team_b 拿 team_a 的 document_id → 全 404。"""
    _init(tmp_path)
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HG_ENV", "test")
    ha = {"Authorization": f"Bearer {_dev_login('team_a')}"}
    hb = {"Authorization": f"Bearer {_dev_login('team_b')}"}
    # team_a 注册文档 + 发版本
    assert client.post("/api/documents", json={"document_id": "d", "title": "D"}, headers=ha).status_code == 200
    assert (
        client.post("/api/documents/d/versions", json={"html_content": "<x/>", "source": "ai-gen"}, headers=ha).status_code
        == 200
    )
    # team_b 对同一 doc_id 全 404
    assert client.get("/api/documents/d", headers=hb).status_code == 404
    assert client.get("/api/documents/d/versions", headers=hb).status_code == 404
    assert client.get("/api/documents/d/versions/1", headers=hb).status_code == 404
    assert (
        client.post("/api/documents/d/versions", json={"html_content": "<y/>", "source": "ai-gen"}, headers=hb).status_code
        == 404
    )
    assert client.delete("/api/documents/d/versions/1", headers=hb).status_code == 404


# === R-3：流密钥 fail-closed ===


def test_stream_secret_fail_closed_in_prod(monkeypatch):
    """生产环境无 HG_STREAM_SECRET/HG_LARK_APP_SECRET → _stream_secret 抛错(fail-closed)。"""
    monkeypatch.delenv("HG_STREAM_SECRET", raising=False)
    monkeypatch.delenv("HG_LARK_APP_SECRET", raising=False)
    monkeypatch.setenv("HG_ENV", "production")
    with pytest.raises(RuntimeError):
        auth._stream_secret()


def test_stream_secret_dev_fallback_ok(monkeypatch):
    """dev/test 环境无密钥 → 用一次性内存密钥(不抛)。"""
    monkeypatch.delenv("HG_STREAM_SECRET", raising=False)
    monkeypatch.delenv("HG_LARK_APP_SECRET", raising=False)
    monkeypatch.setenv("HG_ENV", "test")
    assert isinstance(auth._stream_secret(), bytes)


def test_stream_ticket_endpoint_503_when_no_secret(tmp_path, monkeypatch):
    """生产无密钥 → POST /api/stream/ticket → 503(fail-closed),不回退公开常量。

    注意:这里要 HG_ENV=production 才能触发 fail-closed,而 dev-login 又要求 dev/test
    环境 —— 二者冲突。故用 sessions.create_session 直接造 token(不依赖 dev-login、不受
    HG_ENV 限制),再以生产 + 无密钥调端点。
    """
    _init(tmp_path)
    monkeypatch.setenv("HG_ENV", "production")
    monkeypatch.delenv("HG_STREAM_SECRET", raising=False)
    monkeypatch.delenv("HG_LARK_APP_SECRET", raising=False)
    tok = sessions.create_session("u1", "u1", "team_a")
    r = client.post("/api/stream/ticket", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503


# === owner 角色 + 团队治理 ===


def test_create_team_owner_role(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("MyT", "g_1")
    assert teams.member_role("g_1", tid) == "owner"


def test_redeem_invite_makes_member(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("T", "g_1")
    code = teams.create_invite(tid, "g_1")
    assert teams.redeem_invite(code, "g_2") == tid
    assert teams.member_role("g_2", tid) == "member"


def test_remove_member_owner_only_and_not_self(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("T", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_2")
    with pytest.raises(PermissionError):  # 非 owner
        teams.remove_member(tid, "g_owner", "g_2")
    with pytest.raises(ValueError):  # 移除自己
        teams.remove_member(tid, "g_owner", "g_owner")
    teams.remove_member(tid, "g_2", "g_owner")  # owner 移除 g_2
    assert teams.member_role("g_2", tid) is None


def test_rename_team_owner_only_and_trimmed(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("Before", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_member")
    with pytest.raises(PermissionError):
        teams.rename_team(tid, "After", "g_member")
    assert teams.rename_team(tid, "  After  ", "g_owner") == "After"
    assert next(t for t in teams.user_teams("g_owner") if t["team_id"] == tid)["name"] == "After"
    assert next(t for t in teams.user_teams("g_owner") if t["team_id"] == tid)["role"] == "owner"


def test_transfer_ownership_is_owner_only_and_atomic_role_swap(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("T", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_member")
    with pytest.raises(PermissionError):
        teams.transfer_ownership(tid, "g_owner", "g_member")
    with pytest.raises(ValueError):
        teams.transfer_ownership(tid, "g_missing", "g_owner")
    teams.transfer_ownership(tid, "g_member", "g_owner")
    assert teams.member_role("g_owner", tid) == "member"
    assert teams.member_role("g_member", tid) == "owner"


def test_dissolve_owner_only_and_cascades(tmp_path):
    _init(tmp_path)
    tid = teams.create_team("T", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_2")
    with pytest.raises(PermissionError):  # 非 owner
        teams.dissolve_team(tid, "g_2")
    teams.dissolve_team(tid, "g_owner")  # owner 解散
    assert teams.member_role("g_owner", tid) is None
    assert teams.team_members(tid) == []


def test_team_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_MAX_TEAMS_PER_USER", "2")
    _init(tmp_path)
    teams.create_team("T1", "g_1")
    teams.create_team("T2", "g_1")
    with pytest.raises(teams.TeamLimitExceeded):
        teams.create_team("T3", "g_1")


# === owner 按邮箱加人（档3 增量）===


def test_add_member_by_email_owner_only_and_idempotent(tmp_path):
    """owner 按邮箱加已注册用户 → 入团(幂等,大小写不敏感);非 owner → 403;未注册 → 404;加自己 → 400。"""
    _init(tmp_path)
    tid = teams.create_team("T", "g_owner")
    teams.upsert_user("g_owner", "owner@example.com", "Owner", "")
    teams.upsert_user("g_target", "target@example.com", "Target", "")
    teams.upsert_user("g_member", "member@example.com", "Member", "")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_member")  # g_member = 普通成员
    owner_tok = sessions.create_session("g_owner", "Owner", tid)
    member_tok = sessions.create_session("g_member", "Member", tid)
    H = lambda t: {"Authorization": f"Bearer {t}"}

    # 非 owner → 403
    r = client.post(f"/auth/teams/{tid}/members/by-email",
                    json={"email": "target@example.com"}, headers=H(member_tok))
    assert r.status_code == 403

    # owner 加未注册邮箱 → 404
    r = client.post(f"/auth/teams/{tid}/members/by-email",
                    json={"email": "nobody@example.com"}, headers=H(owner_tok))
    assert r.status_code == 404

    # owner 加已注册用户(大小写不敏感)→ 200 + 入团
    r = client.post(f"/auth/teams/{tid}/members/by-email",
                    json={"email": "TARGET@example.com"}, headers=H(owner_tok))
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Target"
    assert teams.is_member("g_target", tid)

    # 幂等:再加一次仍 200,成员不重复
    r2 = client.post(f"/auth/teams/{tid}/members/by-email",
                     json={"email": "target@example.com"}, headers=H(owner_tok))
    assert r2.status_code == 200
    assert sum(1 for m in teams.team_members(tid) if m["sub"] == "g_target") == 1

    # owner 加自己 → 400
    r = client.post(f"/auth/teams/{tid}/members/by-email",
                    json={"email": "owner@example.com"}, headers=H(owner_tok))
    assert r.status_code == 400


def test_switch_team_session_based(tmp_path):
    """已登录用户切换活跃团队(须成员)→ 该团队新 session;切到非成员团队 → 403。"""
    _init(tmp_path)
    t1 = teams.create_team("T1", "g_u")
    t2 = teams.create_team("T2", "g_other")
    teams.redeem_invite(teams.create_invite(t2, "g_other"), "g_u")  # g_u ∈ T2
    t3 = teams.create_team("T3", "g_x")  # g_u 不在 T3
    tok1 = sessions.create_session("g_u", "U", t1)
    H = {"Authorization": f"Bearer {tok1}"}

    # 切到自己是成员的 T2 → 200,新 token,team=t2,name=T2
    r = client.post("/auth/switch-team", json={"team_id": t2}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["team_id"] == t2
    assert body["team_name"] == "T2"
    assert body["token"] != tok1

    # 用新 token 切到非成员团队 T3 → 403
    r2 = client.post("/auth/switch-team", json={"team_id": t3},
                     headers={"Authorization": f"Bearer {body['token']}"})
    assert r2.status_code == 403


def test_http_team_governance(tmp_path, monkeypatch):
    """端点层:owner 列成员/移除/解散;非 owner/非成员被拒。"""
    _init(tmp_path)
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HG_ENV", "test")
    tid = teams.create_team("T", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_2")
    owner = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_owner', name='owner')}"}
    member = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_2', name='m')}"}
    outsider = {"Authorization": f"Bearer {_dev_login('team_other', open_id='g_x', name='x')}"}
    # owner 列成员 → 200,含 owner+member
    r = client.get(f"/auth/teams/{tid}/members", headers=owner)
    assert r.status_code == 200
    assert {"g_owner", "g_2"} <= {m["sub"] for m in r.json()["items"]}
    # 非成员列成员 → 403
    assert client.get(f"/auth/teams/{tid}/members", headers=outsider).status_code == 403
    # 非 owner 移除 → 403
    assert client.delete(f"/auth/teams/{tid}/members/g_owner", headers=member).status_code == 403
    # owner 移除 g_2 → 200
    assert client.delete(f"/auth/teams/{tid}/members/g_2", headers=owner).status_code == 200
    assert teams.member_role("g_2", tid) is None
    # owner 移除自己 → 400
    assert client.delete(f"/auth/teams/{tid}/members/g_owner", headers=owner).status_code == 400
    # 非 owner 解散 → 403(g_2 已被移除,非成员)
    assert client.delete(f"/auth/teams/{tid}", headers=member).status_code == 403
    # owner 解散 → 200
    assert client.delete(f"/auth/teams/{tid}", headers=owner).status_code == 200
    assert teams.team_members(tid) == []


def test_http_rename_team_owner_only(tmp_path, monkeypatch):
    _init(tmp_path)
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HG_ENV", "test")
    tid = teams.create_team("Before", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_member")
    owner = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_owner', name='owner')}"}
    member = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_member', name='member')}"}
    assert client.patch(f"/auth/teams/{tid}", json={"name": "After"}, headers=member).status_code == 403
    r = client.patch(f"/auth/teams/{tid}", json={"name": "After"}, headers=owner)
    assert r.status_code == 200, r.text
    assert r.json() == {"team_id": tid, "name": "After"}


def test_http_transfer_ownership_owner_only(tmp_path, monkeypatch):
    _init(tmp_path)
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HG_ENV", "test")
    tid = teams.create_team("T", "g_owner")
    teams.redeem_invite(teams.create_invite(tid, "g_owner"), "g_member")
    owner = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_owner', name='owner')}"}
    member = {"Authorization": f"Bearer {_dev_login(tid, open_id='g_member', name='member')}"}
    assert client.post(f"/auth/teams/{tid}/transfer-ownership", json={"sub": "g_owner"}, headers=member).status_code == 403
    r = client.post(f"/auth/teams/{tid}/transfer-ownership", json={"sub": "g_member"}, headers=owner)
    assert r.status_code == 200, r.text
    assert teams.member_role("g_owner", tid) == "member"
    assert teams.member_role("g_member", tid) == "owner"


# === e2e：注册 → 邀请 → 加入 → 协作 ===


def _mock_google(sub, name, monkeypatch):
    monkeypatch.setattr(
        "server.google.verify",
        lambda it: {"sub": sub, "email": sub + "@x.com", "name": name, "picture": ""},
    )


def test_e2e_register_invite_comment(tmp_path, monkeypatch):
    """建团(带名)→邀请→加入→各自 session→发文档+评论→队友 list 可见;跨团队隔离。"""
    _init(tmp_path)
    # Alice 建团(带团队名)
    _mock_google("g_alice", "Alice", monkeypatch)
    j = client.post(
        "/auth/google", json={"id_token": "t", "action": "create", "team_name": "设计组"}
    ).json()
    assert len(j["teams"]) == 1 and j["teams"][0]["name"] == "设计组"
    tid = j["teams"][0]["team_id"]
    Ha = {
        "Authorization": f"Bearer {client.post('/auth/google/session', json={'id_token': 't', 'team_id': tid}).json()['token']}"
    }
    # Alice 生成邀请码(任意成员可生)
    code = client.post("/auth/invites", headers=Ha).json()["code"]
    # Bob 凭码加入
    _mock_google("g_bob", "Bob", monkeypatch)
    jb = client.post(
        "/auth/google", json={"id_token": "t2", "action": "join", "code": code}
    ).json()
    assert any(t["team_id"] == tid for t in jb["teams"])
    Hb = {
        "Authorization": f"Bearer {client.post('/auth/google/session', json={'id_token': 't2', 'team_id': tid}).json()['token']}"
    }
    # Alice 注册文档 + 发评论
    assert client.post("/api/documents", json={"document_id": "d", "title": "D"}, headers=Ha).status_code == 200
    ann = client.post(
        "/api/annotations",
        json={
            "document_id": "d",
            "selector": {"type": "TextQuoteSelector", "exact": "hi"},
            "quote": "hi",
        },
        headers=Ha,
    ).json()
    # Bob(同团队)能看到 Alice 的评论
    items = client.get("/api/annotations?document_id=d", headers=Hb).json()["items"]
    assert any(a["id"] == ann["id"] for a in items)
    # 跨团队:Carol 自建另一团队,看不到 d 的评论
    _mock_google("g_carol", "Carol", monkeypatch)
    jc = client.post(
        "/auth/google", json={"id_token": "t3", "action": "create", "team_name": "C"}
    ).json()
    Hc = {
        "Authorization": f"Bearer {client.post('/auth/google/session', json={'id_token': 't3', 'team_id': jc['teams'][0]['team_id']}).json()['token']}"
    }
    assert client.get("/api/annotations?document_id=d", headers=Hc).json()["items"] == []


def test_diagnostics_endpoint(tmp_path):
    """A+B:诊断上报端点接收任意 JSON、落库、大小封顶(128KB)。"""
    _init(tmp_path)
    r = client.post("/api/diagnostics", json={
        "mode": "manual", "app_version": "0.9.15", "chrome_version": "Chrome/120",
        "last_error": {"code": "CLAUDE_TIMEOUT", "message": "timed out"}, "agent_stream": "…",
    })
    assert r.status_code == 200, r.text
    assert isinstance(r.json().get("id"), int)
    # 超大 → 413
    big = {"x": "a" * (130 * 1024)}
    assert client.post("/api/diagnostics", json=big).status_code == 413

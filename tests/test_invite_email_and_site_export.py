import pytest
from fastapi.testclient import TestClient

from server import sessions, storage, teams
from server.app import app


client = TestClient(app)


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_ENV", "test")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "test-secret")
    storage.init_db(tmp_path / "invite-site.db")


@pytest.fixture
def sent_codes(monkeypatch):
    box = []
    monkeypatch.setattr(
        "server.mailer.send_verification_code",
        lambda email, code: box.append({"email": email, "code": code}),
    )
    return box


def _invite():
    team_id = teams.create_team("Review team", "owner")
    return team_id, teams.create_invite(team_id, "owner")


def _annotation(token, document_id, comment, quote="target"):
    return client.post(
        "/api/annotations",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "document_id": document_id,
            "selector": {
                "type": "TextQuoteSelector",
                "exact": quote,
                "prefix": "before",
                "suffix": "after",
            },
            "quote": quote,
            "body": {"comment": comment, "action": "rewrite", "instruction": "fix it"},
        },
    )


def test_join_page_uses_root_path_and_keeps_legacy_links_working(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    token = sessions.create_session("owner", "Owner", teams.create_team("Review team", "owner"))
    created = client.post("/auth/invites", headers={"Authorization": f"Bearer {token}"})
    assert created.status_code == 200
    body = created.json()
    assert body["join_url"] == f"/join?code={body['code']}"

    current = client.get(body["join_url"])
    legacy = client.get(f"/htmlgenius/join?code={body['code']}")
    assert current.status_code == 200
    assert legacy.status_code == 200
    assert body["code"] in current.text
    assert body["code"] in legacy.text


def test_passwordless_invite_email_joins_and_issues_session(tmp_path, monkeypatch, sent_codes):
    _init(tmp_path, monkeypatch)
    team_id, invite_code = _invite()

    requested = client.post(
        "/auth/invite-email/request",
        json={"email": "Reviewer@Example.com", "invite_code": invite_code},
    )
    assert requested.status_code == 200
    assert requested.json() == {"verify_required": True, "team_name": "Review team"}
    assert sent_codes and sent_codes[-1]["email"] == "reviewer@example.com"

    verified = client.post(
        "/auth/invite-email/verify",
        json={
            "email": "Reviewer@Example.com",
            "invite_code": invite_code,
            "code": sent_codes[-1]["code"],
        },
    )
    assert verified.status_code == 200, verified.text
    body = verified.json()
    assert body["team_id"] == team_id
    assert body["team_name"] == "Review team"
    assert body["user"]["name"] == "reviewer@example.com"
    assert teams.is_member(body["user"]["id"], team_id)
    assert client.get(
        "/auth/me", headers={"Authorization": f"Bearer {body['token']}"}
    ).status_code == 200

    c = storage._connect()
    try:
        user = c.execute(
            "SELECT provider, password_hash, email_verified FROM users WHERE user_id=?",
            (body["user"]["id"],),
        ).fetchone()
        pending = c.execute("SELECT 1 FROM invite_email_verifications").fetchone()
    finally:
        c.close()
    assert dict(user) == {"provider": "email_magic", "password_hash": None, "email_verified": 1}
    assert pending is None


def test_passwordless_invite_rejects_invalid_invite_before_sending(tmp_path, monkeypatch, sent_codes):
    _init(tmp_path, monkeypatch)
    r = client.post(
        "/auth/invite-email/request",
        json={"email": "reviewer@example.com", "invite_code": "inv_missing"},
    )
    assert r.status_code == 400
    assert sent_codes == []


def test_passwordless_invite_wrong_code_does_not_join(tmp_path, monkeypatch, sent_codes):
    _init(tmp_path, monkeypatch)
    team_id, invite_code = _invite()
    client.post(
        "/auth/invite-email/request",
        json={"email": "reviewer@example.com", "invite_code": invite_code},
    )
    wrong = "000000" if sent_codes[-1]["code"] != "000000" else "111111"
    r = client.post(
        "/auth/invite-email/verify",
        json={"email": "reviewer@example.com", "invite_code": invite_code, "code": wrong},
    )
    assert r.status_code == 400
    c = storage._connect()
    try:
        created = c.execute(
            "SELECT 1 FROM users WHERE lower(email)=?", ("reviewer@example.com",)
        ).fetchone()
    finally:
        c.close()
    assert created is None
    assert all(m["sub"] != "reviewer@example.com" for m in teams.team_members(team_id))


def test_passwordless_invite_reuses_existing_email_account(tmp_path, monkeypatch, sent_codes):
    _init(tmp_path, monkeypatch)
    team_id, invite_code = _invite()
    existing_id = teams.create_email_user("member@example.com", "Member", "unused-hash")
    client.post(
        "/auth/invite-email/request",
        json={"email": "member@example.com", "invite_code": invite_code},
    )
    r = client.post(
        "/auth/invite-email/verify",
        json={
            "email": "member@example.com",
            "invite_code": invite_code,
            "code": sent_codes[-1]["code"],
        },
    )
    assert r.status_code == 200
    assert r.json()["user"] == {"id": existing_id, "name": "Member"}
    assert teams.is_member(existing_id, team_id)


def test_site_export_groups_exact_origin_and_isolates_team(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    team_a = teams.create_team("A", "owner-a")
    team_b = teams.create_team("B", "owner-b")
    token_a = sessions.create_session("owner-a", "A", team_a)
    token_b = sessions.create_session("owner-b", "B", team_b)

    assert _annotation(token_a, "https://example.com/", "home").status_code == 200
    assert _annotation(token_a, "https://example.com/pricing", "pricing").status_code == 200
    assert _annotation(token_a, "https://example.com.evil/steal", "evil").status_code == 200
    assert _annotation(token_a, "https://exampleXcom/wildcard", "wildcard").status_code == 200
    assert _annotation(token_b, "https://example.com/private", "other team").status_code == 200
    resolved = _annotation(token_a, "https://example.com/done", "already fixed").json()
    c = storage._connect()
    try:
        c.execute("UPDATE annotations SET status='resolved' WHERE id=?", (resolved["id"],))
    finally:
        c.close()

    headers = {"Authorization": f"Bearer {token_a}"}
    r = client.get(
        "/api/site-annotations",
        params={"site_origin": "https://EXAMPLE.com:443/"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["site_origin"] == "https://example.com"
    assert body["total"] == 2
    assert body["page_count"] == 2
    assert [p["path"] for p in body["pages"]] == ["/", "/pricing"]
    assert {a["body"]["comment"] for p in body["pages"] for a in p["items"]} == {"home", "pricing"}
    assert body["truncated"] is False

    everything = client.get(
        "/api/site-annotations",
        params={"site_origin": "https://example.com", "status": "all"},
        headers=headers,
    ).json()
    assert everything["total"] == 3
    assert {a["status"] for p in everything["pages"] for a in p["items"]} == {"open", "resolved"}

    # SQLite LIKE 的 ``_`` 是通配符；精确 origin 过滤必须把它转义。
    _annotation(token_a, "https://under_score.example/a", "underscore")
    _annotation(token_a, "https://underXscore.example/b", "must not leak")
    escaped = client.get(
        "/api/site-annotations",
        params={"site_origin": "https://under_score.example"},
        headers=headers,
    ).json()
    assert escaped["total"] == 1
    assert escaped["pages"][0]["items"][0]["body"]["comment"] == "underscore"


def test_site_export_requires_session_valid_origin_and_reports_truncation(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    team_id = teams.create_team("A", "owner")
    token = sessions.create_session("owner", "Owner", team_id)
    headers = {"Authorization": f"Bearer {token}"}
    _annotation(token, "https://example.com/a", "one")
    _annotation(token, "https://example.com/b", "two")

    assert client.get(
        "/api/site-annotations", params={"site_origin": "https://example.com"}
    ).status_code == 401
    assert client.get(
        "/api/site-annotations",
        params={"site_origin": "https://example.com/path"},
        headers=headers,
    ).status_code == 422
    limited = client.get(
        "/api/site-annotations",
        params={"site_origin": "https://example.com", "limit": 1},
        headers=headers,
    ).json()
    assert limited["total"] == 1 and limited["truncated"] is True

import os
from fastapi.testclient import TestClient
from server import storage
from server.app import app
from server.models import DocumentCreate

client = TestClient(app)


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_TEAMS", '{"tok_a":"team_a","tok_b":"team_b"}')
    storage.init_db(tmp_path / "a.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))


def test_no_token_401(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.get("/api/annotations", params={"document_id": "doc_x"})
    assert r.status_code == 401


def test_bad_token_401(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    r = client.get("/api/annotations", params={"document_id": "doc_x"},
                   headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_team_isolation_via_http(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    # team_a 创建 (header value 用 ASCII,TestClient/httpx 限制)
    r = client.post("/api/annotations",
                    json={"document_id": "doc_x", "selector": {"type": "TextQuoteSelector", "exact": "hi"}, "quote": "hi"},
                    headers={"Authorization": "Bearer tok_a", "X-User-Id": "u1", "X-User-Name": "user_one"})
    assert r.status_code == 200 and r.json()["team_id"] == "team_a"
    # team_a 看得到
    a = client.get("/api/annotations", params={"document_id": "doc_x"}, headers={"Authorization": "Bearer tok_a"})
    assert len(a.json()["items"]) == 1
    # team_b 看不到
    b = client.get("/api/annotations", params={"document_id": "doc_x"}, headers={"Authorization": "Bearer tok_b"})
    assert b.json()["items"] == []


def test_author_from_headers(tmp_path, monkeypatch):
    """author 应来自 X-User-Id / X-User-Name 头,而非请求体。"""
    _init(tmp_path, monkeypatch)
    r = client.post("/api/annotations",
                    json={"document_id": "doc_x",
                          "selector": {"type": "TextQuoteSelector", "exact": "hi"},
                          "quote": "hi",
                          "author": {"id": "body_id", "name": "body_name"}},
                    headers={"Authorization": "Bearer tok_a", "X-User-Id": "u_header", "X-User-Name": "header_author"})
    assert r.status_code == 200
    assert r.json()["author"] == {"id": "u_header", "name": "header_author"}


def test_require_team_query_helper(tmp_path, monkeypatch):
    """require_team_query (Query 依赖) 给 SSE 端点用,这里直接单元验证。"""
    from server.auth import require_team_query
    monkeypatch.setenv("HG_TEAMS", '{"tok_a":"team_a"}')
    assert require_team_query(token="tok_a") == "team_a"
    try:
        require_team_query(token="wrong")
    except Exception as e:
        assert getattr(e, "status_code", None) == 401
    else:
        raise AssertionError("expected 401 for bad query token")

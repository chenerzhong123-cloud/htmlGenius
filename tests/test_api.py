import os

from fastapi.testclient import TestClient

from server import storage
from server.app import app

client = TestClient(app)

# v0.4: 批注端点需 team token。老测试沿用 test_api 自带的默认 team token。
_AUTH = {"Authorization": "Bearer t_test"}


def test_annotation_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_TEAMS", '{"t_test":"team_test"}')
    storage.init_db(tmp_path / "a.db")

    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_x",
            "selector": {"exact": "最小单位", "prefix": "前", "suffix": "后"},
            "quote": "最小单位",
            "body": {"comment": "改一下", "action": "rewrite", "instruction": ""},
        },
        headers=_AUTH,
    )
    assert r.status_code == 200
    ann = r.json()
    assert ann["id"].startswith("ann_") and ann["selector"]["exact"] == "最小单位"

    r2 = client.get("/api/annotations", params={"document_id": "doc_x"}, headers=_AUTH)
    assert r2.status_code == 200
    assert len(r2.json()["items"]) == 1


def test_delete_annotation(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_TEAMS", '{"t_test":"team_test"}')
    storage.init_db(tmp_path / "d.db")
    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_d",
            "selector": {"exact": "x", "prefix": "", "suffix": ""},
            "quote": "x",
        },
        headers=_AUTH,
    )
    aid = r.json()["id"]

    rd = client.delete(f"/api/annotations/{aid}")
    assert rd.status_code == 200 and rd.json() == {"ok": True}

    r3 = client.get("/api/annotations", params={"document_id": "doc_d"}, headers=_AUTH)
    assert len(r3.json()["items"]) == 0

    rd2 = client.delete(f"/api/annotations/{aid}")
    assert rd2.status_code == 404

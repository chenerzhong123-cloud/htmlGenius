from fastapi.testclient import TestClient

from server import sessions, storage
from server.app import app

client = TestClient(app)


def test_annotation_roundtrip(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "a.db")
    tok = sessions.create_session("ou_test", "测试", "team_test")
    auth = {"Authorization": f"Bearer {tok}"}

    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_x",
            "selector": {"exact": "最小单位", "prefix": "前", "suffix": "后"},
            "quote": "最小单位",
            "body": {"comment": "改一下", "action": "rewrite", "instruction": ""},
        },
        headers=auth,
    )
    assert r.status_code == 200
    ann = r.json()
    assert ann["id"].startswith("ann_") and ann["selector"]["exact"] == "最小单位"
    assert ann["author"] == {"id": "ou_test", "name": "测试"}  # v0.5: 来自 session

    r2 = client.get("/api/annotations", params={"document_id": "doc_x"}, headers=auth)
    assert r2.status_code == 200
    assert len(r2.json()["items"]) == 1


def test_delete_annotation(tmp_path, monkeypatch):
    # v0.5: author 来自 session(open_id)。作者本人删 → 200;二次删 → 空 deleted。
    storage.init_db(tmp_path / "d.db")
    tok = sessions.create_session("u_test", "作者", "team_test")
    auth = {"Authorization": f"Bearer {tok}"}
    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_d",
            "selector": {"exact": "x", "prefix": "", "suffix": ""},
            "quote": "x",
        },
        headers=auth,
    )
    aid = r.json()["id"]

    rd = client.delete(f"/api/annotations/{aid}", headers=auth)
    assert rd.status_code == 200
    assert rd.json() == {"ok": True, "deleted": [aid]}

    r3 = client.get("/api/annotations", params={"document_id": "doc_d"}, headers=auth)
    assert len(r3.json()["items"]) == 0

    # 二次删:行已不存在 → delete_annotation 返回 [],端点仍 200(空 deleted)
    rd2 = client.delete(f"/api/annotations/{aid}", headers=auth)
    assert rd2.status_code == 200
    assert rd2.json() == {"ok": True, "deleted": []}

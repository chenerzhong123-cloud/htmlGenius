from fastapi.testclient import TestClient

from server import storage
from server.app import app

client = TestClient(app)


def test_annotation_roundtrip(tmp_path):
    storage.init_db(tmp_path / "a.db")

    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_x",
            "selector": {"exact": "最小单位", "prefix": "前", "suffix": "后"},
            "quote": "最小单位",
            "body": {"comment": "改一下", "action": "rewrite", "instruction": ""},
        },
    )
    assert r.status_code == 200
    ann = r.json()
    assert ann["id"].startswith("ann_") and ann["selector"]["exact"] == "最小单位"

    r2 = client.get("/api/annotations", params={"document_id": "doc_x"})
    assert r2.status_code == 200
    assert len(r2.json()["items"]) == 1


def test_delete_annotation(tmp_path):
    storage.init_db(tmp_path / "d.db")
    r = client.post(
        "/api/annotations",
        json={
            "document_id": "doc_d",
            "selector": {"exact": "x", "prefix": "", "suffix": ""},
            "quote": "x",
        },
    )
    aid = r.json()["id"]

    rd = client.delete(f"/api/annotations/{aid}")
    assert rd.status_code == 200 and rd.json() == {"ok": True}

    r3 = client.get("/api/annotations", params={"document_id": "doc_d"})
    assert len(r3.json()["items"]) == 0

    rd2 = client.delete(f"/api/annotations/{aid}")
    assert rd2.status_code == 404

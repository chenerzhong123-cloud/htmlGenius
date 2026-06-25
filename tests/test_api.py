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

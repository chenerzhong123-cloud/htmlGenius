import sqlite3

from fastapi.testclient import TestClient

from server import storage
from server.app import app
from server.models import (
    AnnotationCreate,
    DocumentCreate,
    TextQuoteSelector,
)

client = TestClient(app)


def _init(tmp_path):
    storage.init_db(tmp_path / "t.db")
    storage.register_document(DocumentCreate(document_id="doc_e"))


def test_versions_roundtrip_and_html_content(tmp_path):
    _init(tmp_path)
    r = client.post(
        "/api/documents/doc_e/versions",
        json={"html_content": "<html><head><style>.a{}</style></head><body>X</body></html>", "source": "edit"},
    )
    assert r.status_code == 200
    v = r.json()["version"]
    assert v == 1
    html = client.get(f"/api/documents/doc_e/versions/{v}").text
    assert "<style>" in html and "<body>X</body>" in html
    lst = client.get("/api/documents/doc_e/versions").json()
    assert len(lst["items"]) == 1


def test_window_deletes_old_and_migrates_annotation_version(tmp_path):
    _init(tmp_path)
    client.post("/api/documents/doc_e/versions", json={"html_content": "v1", "source": "edit"})  # v1
    ann = storage.save_annotation(
        AnnotationCreate(document_id="doc_e", version=1, selector=TextQuoteSelector(exact="x"), quote="x")
    )
    for i in range(2, 5):  # v2 v3 v4
        client.post("/api/documents/doc_e/versions", json={"html_content": f"v{i}", "source": "edit"})
    deleted = storage.enforce_window("doc_e", keep=3)
    assert 1 in deleted  # v1 超窗被删
    a = storage.get_annotation(ann["id"])
    assert a["version"] == 4  # 批注 version 迁移到 current


def test_delete_version_migrates_annotation(tmp_path):
    _init(tmp_path)
    for i in range(1, 4):  # v1 v2 v3
        client.post("/api/documents/doc_e/versions", json={"html_content": f"v{i}", "source": "edit"})
    ann = storage.save_annotation(
        AnnotationCreate(document_id="doc_e", version=1, selector=TextQuoteSelector(exact="x"), quote="x")
    )
    assert storage.delete_version("doc_e", 1) is True
    a = storage.get_annotation(ann["id"])
    assert a["version"] == 3  # 迁移到 current
    # 不能删 current
    try:
        storage.delete_version("doc_e", 3)
        assert False, "应禁止删 current"
    except ValueError:
        pass


def test_migration_adds_html_content_column(tmp_path):
    db = tmp_path / "old.db"
    cc = sqlite3.connect(db)
    cc.executescript(
        "CREATE TABLE versions (document_id TEXT, version INTEGER, html_path TEXT, created_at TEXT, source TEXT, parent INTEGER, PRIMARY KEY(document_id,version));"
        "CREATE TABLE documents (document_id TEXT PRIMARY KEY, title TEXT, current_version INTEGER);"
    )
    cc.commit()
    cc.close()
    storage.init_db(db)  # 触发迁移
    cc = sqlite3.connect(db)
    cols = {r[1] for r in cc.execute("PRAGMA table_info(versions)")}
    cc.close()
    assert "html_content" in cols

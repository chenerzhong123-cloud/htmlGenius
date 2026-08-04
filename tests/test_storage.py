import sqlite3
from pathlib import Path

from server import storage
from server.models import (
    AnnotationCreate,
    DocumentCreate,
    TextQuoteSelector,
    VersionCreate,
)


def _init(tmp_path: Path) -> Path:
    db = tmp_path / "t.db"
    storage.init_db(db)
    return db


def test_register_and_version(tmp_path):
    _init(tmp_path)
    storage.register_document("default", DocumentCreate(document_id="doc_a", title="A"))
    r = storage.add_version("default", "doc_a", VersionCreate(html_path="/x.html", source="ai-gen"))
    assert r["version"] == 1
    doc = storage.get_document("default", "doc_a")
    assert doc["current_version"] == 1
    assert len(doc["versions"]) == 1


def test_save_and_list_annotation(tmp_path):
    _init(tmp_path)
    storage.register_document("default", DocumentCreate(document_id="doc_a"))
    payload = AnnotationCreate(
        document_id="doc_a",
        selector=TextQuoteSelector(exact="最小单位", prefix="前", suffix="后"),
        quote="最小单位",
    )
    ann = storage.save_annotation(payload)
    assert ann["id"].startswith("ann_")
    assert ann["status"] == "open"
    assert ann["selector"]["exact"] == "最小单位"
    items = storage.list_annotations("doc_a")
    assert len(items) == 1 and items[0]["id"] == ann["id"]


# === R-1：schema 迁移（documents/versions team_id 复合键；memberships role） ===


def test_schema_team_scoped(tmp_path):
    """全新库：documents/versions 含 team_id；memberships 含 role。"""
    db = tmp_path / "t.db"
    storage.init_db(db)
    con = sqlite3.connect(db)
    try:
        assert "team_id" in {r[1] for r in con.execute("PRAGMA table_info(documents)")}
        assert "team_id" in {r[1] for r in con.execute("PRAGMA table_info(versions)")}
        assert "role" in {r[1] for r in con.execute("PRAGMA table_info(memberships)")}
    finally:
        con.close()


def test_migrates_legacy_documents_to_default(tmp_path):
    """存量库（无 team_id 的 documents/versions）→ init_db → 行回填 team_id='default'。"""
    db = tmp_path / "leg.db"
    con = sqlite3.connect(db)
    try:
        con.executescript(
            """
            CREATE TABLE documents (document_id TEXT PRIMARY KEY, title TEXT, current_version INTEGER);
            CREATE TABLE versions (document_id TEXT, version INTEGER, html_path TEXT, created_at TEXT,
                                   source TEXT, parent INTEGER, html_content TEXT, PRIMARY KEY (document_id, version));
            CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT, created_by_sub TEXT, created_at TEXT);
            CREATE TABLE memberships (google_sub TEXT, team_id TEXT, joined_at TEXT, PRIMARY KEY (google_sub, team_id));
            INSERT INTO documents VALUES ('d1','T',2);
            INSERT INTO versions VALUES ('d1',1,'/p','now','ai-gen',NULL,'<html/>');
            """
        )
        con.commit()
    finally:
        con.close()

    storage.init_db(db)  # 触发迁移
    con = sqlite3.connect(db)
    try:
        assert con.execute(
            "SELECT team_id,document_id,title,current_version FROM documents"
        ).fetchone() == ("default", "d1", "T", 2)
        assert con.execute(
            "SELECT team_id,document_id,version FROM versions"
        ).fetchone() == ("default", "d1", 1)
    finally:
        con.close()

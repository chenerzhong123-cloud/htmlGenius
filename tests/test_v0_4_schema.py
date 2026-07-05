import sqlite3

from server import storage
from server.models import AnnotationCreate, DocumentCreate, TextQuoteSelector


def _init(tmp_path):
    storage.init_db(tmp_path / "s.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))


def test_migration_adds_team_and_parent_columns(tmp_path):
    db = tmp_path / "old.db"
    cc = sqlite3.connect(db)
    cc.executescript(
        "CREATE TABLE documents (document_id TEXT PRIMARY KEY, title TEXT, current_version INTEGER);"
        "CREATE TABLE annotations (id TEXT PRIMARY KEY, document_id TEXT, version INTEGER, created_at TEXT,"
        " updated_at TEXT, author TEXT, scope TEXT, status TEXT, selector TEXT, quote TEXT, body TEXT);"
    )
    cc.close()
    storage.init_db(db)
    cc = sqlite3.connect(db)
    cols = {r[1] for r in cc.execute("PRAGMA table_info(annotations)")}
    cc.close()
    assert "team_id" in cols and "parent_id" in cols


def test_save_and_list_with_team_id(tmp_path):
    _init(tmp_path)
    a = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="hi"),
            quote="hi",
            author={"id": "u1", "name": "阿甲"},
        ),
        team_id="team_a",
    )
    assert a["team_id"] == "team_a" and a["author"] == {"id": "u1", "name": "阿甲"}
    items = storage.list_annotations("doc_x", team_id="team_a")
    assert len(items) == 1 and items[0]["id"] == a["id"]
    # team 隔离:team_b 看不到
    assert storage.list_annotations("doc_x", team_id="team_b") == []

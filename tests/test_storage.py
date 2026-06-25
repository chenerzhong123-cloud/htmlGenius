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
    storage.register_document(DocumentCreate(document_id="doc_a", title="A"))
    r = storage.add_version("doc_a", VersionCreate(html_path="/x.html", source="ai-gen"))
    assert r["version"] == 1
    doc = storage.get_document("doc_a")
    assert doc["current_version"] == 1
    assert len(doc["versions"]) == 1


def test_save_and_list_annotation(tmp_path):
    _init(tmp_path)
    storage.register_document(DocumentCreate(document_id="doc_a"))
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

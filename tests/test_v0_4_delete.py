import pytest
from fastapi.testclient import TestClient
from server import sessions, storage
from server.app import app
from server.models import AnnotationCreate, DocumentCreate, TextQuoteSelector

client = TestClient(app)


def _init(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "d.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))


def _mk(team, uid, parent=None):
    return storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="x"),
            quote="x",
            author={"id": uid, "name": uid},
            parent_id=parent,
        ),
        team_id=team,
    )


# === storage 层(不经过鉴权,行为不变) ===


def test_owner_deletes_and_cascades(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    parent = _mk("team_a", "u1")
    child = _mk("team_a", "u2", parent=parent["id"])
    grand = _mk("team_a", "u3", parent=child["id"])
    deleted = storage.delete_annotation(parent["id"], "team_a", "u1")
    assert set(d["id"] for d in deleted) == {parent["id"], child["id"], grand["id"]}
    assert all(d["document_id"] == "doc_x" for d in deleted)
    assert storage.get_annotation(child["id"]) is None


def test_non_owner_forbidden(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    with pytest.raises(PermissionError):
        storage.delete_annotation(a["id"], "team_a", "u2")
    assert storage.get_annotation(a["id"]) is not None  # 未删


def test_wrong_team_forbidden(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    with pytest.raises(PermissionError):
        storage.delete_annotation(a["id"], "team_b", "u1")


def test_absent_id_returns_empty(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    deleted = storage.delete_annotation("ann_nope", "team_a", "u1")
    assert deleted == []


# === 端点层(v0.5: require_session,作者 = session.open_id) ===


def test_http_403_for_non_owner(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    tok = sessions.create_session("u2", "u2", "team_a")  # 同 team,非作者
    r = client.delete(
        f"/api/annotations/{a['id']}", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 403


def test_http_owner_deletes_cascades(tmp_path, monkeypatch):
    """端点层:作者删 → 200,deleted 含整棵子树 id;被删子节点 GET 单条拿不到。"""
    _init(tmp_path, monkeypatch)
    parent = _mk("team_a", "u1")
    child = _mk("team_a", "u2", parent=parent["id"])
    tok = sessions.create_session("u1", "u1", "team_a")  # 作者
    r = client.delete(
        f"/api/annotations/{parent['id']}", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200
    deleted_ids = set(r.json()["deleted"])
    assert deleted_ids == {parent["id"], child["id"]}
    assert storage.get_annotation(child["id"]) is None


def test_http_wrong_team_403(tmp_path, monkeypatch):
    """端点层:session 属 team_b,批注在 team_a → 403。"""
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    tok = sessions.create_session("u1", "u1", "team_b")  # 不同 team
    r = client.delete(
        f"/api/annotations/{a['id']}", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 403

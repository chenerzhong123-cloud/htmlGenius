"""v0.5 编辑评论:PATCH /api/annotations/:id(作者校验 + body 合并)。

镜像 test_v0_4_delete 的范式:storage 层 + 端点层。
"""
import pytest
from fastapi.testclient import TestClient
from server import sessions, storage
from server.app import app
from server.models import AnnotationCreate, DocumentCreate, TextQuoteSelector

client = TestClient(app)


def _init(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "edit.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))


def _mk(team, uid, parent=None):
    return storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="x"),
            quote="x",
            body={"comment": "orig", "action": "rewrite", "instruction": ""},
            author={"id": uid, "name": uid},
            parent_id=parent,
        ),
        team_id=team,
    )


# === storage 层 ===


def test_owner_update_merges_body(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    out = storage.update_annotation(a["id"], "team_a", "u1", {"comment": "edited"})
    assert out is not None
    assert out["body"]["comment"] == "edited"
    assert out["body"]["action"] == "rewrite"  # 合并:保留原有字段
    assert out["updated_at"] >= a["updated_at"]


def test_non_owner_forbidden(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    with pytest.raises(PermissionError):
        storage.update_annotation(a["id"], "team_a", "u2", {"comment": "hack"})
    assert storage.get_annotation(a["id"])["body"]["comment"] == "orig"  # 未改


def test_wrong_team_forbidden(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    with pytest.raises(PermissionError):
        storage.update_annotation(a["id"], "team_b", "u1", {"comment": "hack"})


def test_absent_id_returns_none(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    assert storage.update_annotation("ann_nope", "team_a", "u1", {"comment": "x"}) is None


# === 端点层(v0.5: require_session,作者 = session.open_id) ===


def test_http_owner_update(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    tok = sessions.create_session("u1", "u1", "team_a")  # 作者
    r = client.patch(
        f"/api/annotations/{a['id']}",
        headers={"Authorization": f"Bearer {tok}"},
        json={"body": {"comment": "edited"}},
    )
    assert r.status_code == 200
    assert r.json()["body"]["comment"] == "edited"


def test_http_403_for_non_owner(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    tok = sessions.create_session("u2", "u2", "team_a")  # 同 team,非作者
    r = client.patch(
        f"/api/annotations/{a['id']}",
        headers={"Authorization": f"Bearer {tok}"},
        json={"body": {"comment": "hack"}},
    )
    assert r.status_code == 403


def test_http_403_wrong_team(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    tok = sessions.create_session("u1", "u1", "team_b")  # 不同 team
    r = client.patch(
        f"/api/annotations/{a['id']}",
        headers={"Authorization": f"Bearer {tok}"},
        json={"body": {"comment": "hack"}},
    )
    assert r.status_code == 403


def test_http_404_absent(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("u1", "u1", "team_a")
    r = client.patch(
        "/api/annotations/ann_nope",
        headers={"Authorization": f"Bearer {tok}"},
        json={"body": {"comment": "x"}},
    )
    assert r.status_code == 404


def test_http_no_auth_401(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    a = _mk("team_a", "u1")
    r = client.patch(f"/api/annotations/{a['id']}", json={"body": {"comment": "x"}})
    assert r.status_code in (401, 403)  # require_session 未通过

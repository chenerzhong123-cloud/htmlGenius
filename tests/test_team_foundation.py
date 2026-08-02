"""团队地基 (scope A) 测试。

R-1：文档/版本按 team_id 强制隔离（storage 层 + HTTP 层）。
后续任务追加：R-3 fail-closed / owner 治理 / e2e。
"""
import pytest
from fastapi.testclient import TestClient

from server import storage
from server.app import app
from server.models import DocumentCreate, VersionCreate

client = TestClient(app)


def _init(tmp_path):
    storage.init_db(tmp_path / "tf.db")


def _dev_login(team, open_id=None, name=None):
    """dev-login 旁路直接造指定 team 的 session（需 HG_AUTH_ALLOW_DEV + HG_ENV=test）。"""
    r = client.post(
        "/auth/dev-login",
        json={"open_id": open_id or team, "name": name or team, "team": team},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


# === R-1：storage 层文档/版本按 team 隔离 ===


def test_storage_team_document_isolation(tmp_path):
    """team_a、team_b 同名 doc 互不可见；版本号各自独立。"""
    _init(tmp_path)
    storage.register_document("team_a", DocumentCreate(document_id="d", title="A"))
    storage.register_document("team_b", DocumentCreate(document_id="d", title="B"))
    assert storage.get_document("team_a", "d")["title"] == "A"
    assert storage.get_document("team_b", "d")["title"] == "B"
    storage.add_version("team_a", "d", VersionCreate(html_content="<a/>", source="ai-gen"))
    assert storage.get_document("team_a", "d")["current_version"] == 1
    assert storage.get_document("team_b", "d")["current_version"] == 0  # 不受影响


def test_storage_other_team_doc_invisible(tmp_path):
    """team_b 查 team_a 的 doc → get_document None / 版本 html None / 版本列表空。"""
    _init(tmp_path)
    storage.register_document("team_a", DocumentCreate(document_id="d"))
    storage.add_version("team_a", "d", VersionCreate(html_content="<x/>", source="ai-gen"))
    assert storage.get_document("team_b", "d") is None
    assert storage.get_version_html("team_b", "d", 1) is None
    assert storage.list_versions("team_b", "d") == []


# === R-1：HTTP 层（app.py 传 session.team_id） ===


def test_http_team_document_isolation(tmp_path, monkeypatch):
    """team_b 拿 team_a 的 document_id → 全 404。"""
    _init(tmp_path)
    monkeypatch.setenv("HG_AUTH_ALLOW_DEV", "1")
    monkeypatch.setenv("HG_ENV", "test")
    ha = {"Authorization": f"Bearer {_dev_login('team_a')}"}
    hb = {"Authorization": f"Bearer {_dev_login('team_b')}"}
    # team_a 注册文档 + 发版本
    assert client.post("/api/documents", json={"document_id": "d", "title": "D"}, headers=ha).status_code == 200
    assert (
        client.post("/api/documents/d/versions", json={"html_content": "<x/>", "source": "ai-gen"}, headers=ha).status_code
        == 200
    )
    # team_b 对同一 doc_id 全 404
    assert client.get("/api/documents/d", headers=hb).status_code == 404
    assert client.get("/api/documents/d/versions", headers=hb).status_code == 404
    assert client.get("/api/documents/d/versions/1", headers=hb).status_code == 404
    assert (
        client.post("/api/documents/d/versions", json={"html_content": "<y/>", "source": "ai-gen"}, headers=hb).status_code
        == 404
    )
    assert client.delete("/api/documents/d/versions/1", headers=hb).status_code == 404

import time

from server import storage, sessions


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_SESSION_TTL", "60")
    storage.init_db(tmp_path / "s.db")


def test_create_and_get(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_1", "alice", "team_a")
    assert isinstance(tok, str) and tok.startswith("sess_")
    s = sessions.get_session(tok)
    assert s == {"open_id": "ou_1", "name": "alice", "team_id": "team_a"}


def test_missing_returns_none(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    assert sessions.get_session("sess_nope") is None


def test_expired_returns_none(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_2", "bob", "team_a", ttl=1)
    time.sleep(1.2)
    assert sessions.get_session(tok) is None


def test_delete(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_3", "carol", "team_a")
    assert sessions.delete_session(tok) is True
    assert sessions.get_session(tok) is None
    assert sessions.delete_session(tok) is False


def test_prune(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    sessions.create_session("ou_4", "dan", "team_a", ttl=1)
    time.sleep(1.2)
    assert sessions.prune_expired() == 1

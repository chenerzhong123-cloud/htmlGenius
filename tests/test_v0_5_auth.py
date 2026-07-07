import time

import pytest
from fastapi import HTTPException

from server import storage, sessions
from server.auth import (
    consume_state,
    issue_state,
    require_session,
    require_session_query,
)


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_xxx")
    storage.init_db(tmp_path / "a.db")


def test_require_session_ok(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_1", "alice", "team_a")
    s = require_session(authorization=f"Bearer {tok}")
    assert s.open_id == "ou_1" and s.team_id == "team_a"


def test_require_session_missing(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as e:
        require_session(authorization=None)
    assert e.value.status_code == 401


def test_require_session_bad(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as e:
        require_session(authorization="Bearer sess_nope")
    assert e.value.status_code == 401


def test_require_session_query(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_2", "bob", "team_b")
    assert require_session_query(token=tok).team_id == "team_b"
    with pytest.raises(HTTPException) as e:
        require_session_query(token=None)
    assert e.value.status_code == 401


def test_state_roundtrip(monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_xxx")
    st = issue_state()
    assert consume_state(st) is True
    assert consume_state("garbage") is False


def test_state_expiry(monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_xxx")
    import server.auth as a

    st = issue_state()
    orig = time.time
    # 把"现在"往后推 400s,使 state 超 5min TTL
    monkeypatch.setattr(time, "time", lambda: orig() + 400)
    # consume_state 用的是 server.auth.time(已 import time),patch 同一对象
    monkeypatch.setattr(a.time, "time", lambda: orig() + 400)
    assert consume_state(st) is False
